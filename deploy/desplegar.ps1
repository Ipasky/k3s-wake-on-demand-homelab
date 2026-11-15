<#
  desplegar.ps1: envía los ficheros del clúster a cada máquina y los instala allí.

  Uso (PowerShell, en la carpeta del repositorio):
      .\deploy\desplegar.ps1                 # todas las máquinas
      .\deploy\desplegar.ps1 -Solo mustang   # solo una
      .\deploy\desplegar.ps1 -Probar         # muestra qué haría, sin tocar nada
      .\deploy\desplegar.ps1 -Generar        # solo genera en privado\generado\ los manifiestos de K3s,
                                      # cortafuegos y CrowdSec ya rellenados (para aplicarlos a mano)

  Los valores de TU instalación (dominio, IPs, MAC, usuarios…) están en config\local.env, que
  git ignora. Cada @@NOMBRE@@ de los ficheros se sustituye por su valor antes de enviarlos; si
  queda alguno sin valor, no se envía nada.

  Requiere acceso SSH por clave y pedirá la contraseña de sudo en cada máquina.
  Convierte los ficheros de texto a saltos de línea de Linux.
#>
param(
  [string]$Solo = "",
  [switch]$Probar,
  [switch]$Generar
)

$ErrorActionPreference = "Stop"
$Origen = Split-Path $PSScriptRoot -Parent      # la raíz del repositorio (este script vive en deploy\)
if (-not $Origen) { $Origen = (Get-Location).Path }

# ------------------------------------------------------------ valores locales
$FicheroEnv = Join-Path $Origen "config\local.env"
if (-not (Test-Path $FicheroEnv)) {
  Write-Host "Falta config\local.env: copia config\local.env.example y rellénalo." -ForegroundColor Red; exit 1
}
$Valores = @{}
foreach ($linea in Get-Content $FicheroEnv -Encoding UTF8) {
  if ($linea -match '^\s*([A-Z][A-Z0-9_]*)=(.*)$') {
    $v = $Matches[2]
    if ($v -match '^"([^"]*)"') { $v = $Matches[1] }        # entre comillas: tal cual
    else { $v = ($v -replace '\s+#.*$', '').Trim() }        # sin comillas: fuera el comentario
    $Valores[$Matches[1]] = $v
  }
}

$Binarios = @(".png", ".jpg", ".jpeg", ".ico", ".webp", ".woff2")
$Pendientes = @()

function Rellenar([string]$ruta) {
  # Devuelve el texto con los @@NOMBRE@@ sustituidos y saltos de línea de Linux
  $texto = [IO.File]::ReadAllText($ruta) -replace "`r`n", "`n"
  foreach ($k in $Valores.Keys) { $texto = $texto.Replace("@@$k@@", $Valores[$k]) }
  $faltan = [regex]::Matches($texto, '@@[A-Z][A-Z0-9_]*@@') | ForEach-Object { $_.Value } | Sort-Object -Unique
  if ($faltan) { $script:Pendientes += "$ruta -> $($faltan -join ', ')" }
  return $texto
}

function Escribir([string]$fuente, [string]$salida) {
  $carpeta = Split-Path $salida -Parent
  if (-not (Test-Path $carpeta)) { New-Item -ItemType Directory -Path $carpeta -Force | Out-Null }
  if ($Binarios -contains [IO.Path]::GetExtension($fuente).ToLower()) { Copy-Item $fuente $salida }
  else { [IO.File]::WriteAllText($salida, (Rellenar $fuente), (New-Object Text.UTF8Encoding($false))) }
}

# ------------------------------------------------------------ -Generar
if ($Generar) {
  $Destino = Join-Path $Origen "privado\generado"
  if (Test-Path $Destino) { Remove-Item $Destino -Recurse -Force }
  foreach ($d in @("k8s", "config\nftables", "config\crowdsec")) {
    Get-ChildItem (Join-Path $Origen $d) -File | ForEach-Object {
      Escribir $_.FullName (Join-Path $Destino (Join-Path $d $_.Name))
    }
  }
  if ($Pendientes) { Write-Host "Sin valor en config\local.env:`n  $($Pendientes -join "`n  ")" -ForegroundColor Red; exit 1 }
  Write-Host "Generado en $Destino (no lo subas a git: está ignorado)." -ForegroundColor Green
  exit 0
}

# ------------------------------------------------------------ qué va a cada máquina
# origen (en el repositorio) => nombre con el que llega (instalar.sh lo espera así)
$Scripts = @("nodo", "nodo-controlador", "hpc-backup", "hpc-copia", "hpc-respaldo", "vigilar-wol", "wakeonlan-registro",
             "revisar-smart", "recoger-smart", "hpc-crowdsec", "desplegar-app", "importar-imagen")
$Pi = @()
$Pi += $Scripts | ForEach-Object { "scripts\$_" }
$SoloNodos = @("rearmar-wol.service")          # unidades que van a los nodos, no a la Pi
$Pi += Get-ChildItem (Join-Path $Origen "systemd") -File | Where-Object { $SoloNodos -notcontains $_.Name } |
       ForEach-Object { "systemd\$($_.Name)" }
$Pi += "panel\despertador.py"
$Pi += Get-ChildItem (Join-Path $Origen "panel\static") -File | ForEach-Object { "panel\static\$($_.Name)" }
$Pi += "config\nodo-controlador.env"
# Configuración propia: la real si existe (ignorada por git); si no, nada (instalar.sh no pisa la de la Pi)
foreach ($c in @("config\servicios.yaml", "config\hpc-respaldo-fuentes.conf")) {
  if (Test-Path (Join-Path $Origen $c)) { $Pi += $c }
}
$Nodo = @("scripts\revisar-smart", "systemd\revisar-smart.service", "systemd\revisar-smart.timer",
          "scripts\rearmar-wol", "systemd\rearmar-wol.service")

$Maquinas = @(
  @{ Nombre = "pi-master"; Destino = "$($Valores.USUARIO_PI)@$($Valores.IP_PI)";           Ficheros = $Pi },
  @{ Nombre = "faraday";   Destino = "$($Valores.USUARIO_FARADAY)@$($Valores.IP_FARADAY)"; Ficheros = $Nodo },
  @{ Nombre = "mustang";   Destino = "$($Valores.USUARIO_MUSTANG)@$($Valores.IP_MUSTANG)"; Ficheros = $Nodo }
)

function NombreDestino([string]$f) {
  if ($f -like "panel\static\*") { return "static\" + (Split-Path $f -Leaf) }
  return (Split-Path $f -Leaf)
}

$Temp = Join-Path $env:TEMP "hpc-desplegar"

foreach ($m in $Maquinas) {
  if ($Solo -and $m.Nombre -ne $Solo) { continue }
  Write-Host "`n=== $($m.Nombre) ($($m.Destino)) ===" -ForegroundColor Cyan

  if (Test-Path $Temp) { Remove-Item $Temp -Recurse -Force }
  New-Item -ItemType Directory -Path $Temp | Out-Null
  $Pendientes = @()

  $enviados = @()
  foreach ($f in $m.Ficheros) {
    $ruta = Join-Path $Origen $f
    if (-not (Test-Path $ruta)) { continue }
    Escribir $ruta (Join-Path $Temp (NombreDestino $f))
    $enviados += (NombreDestino $f)
  }
  Escribir (Join-Path $Origen "deploy\instalar.sh") (Join-Path $Temp "instalar.sh")

  if ($Pendientes) {
    Write-Host "No se envía nada: faltan valores en config\local.env:`n  $($Pendientes -join "`n  ")" -ForegroundColor Red
    exit 1
  }
  if ($enviados.Count -eq 0) { Write-Host "   (nada para esta máquina)" -ForegroundColor DarkGray; continue }
  Write-Host ("   ficheros: " + ($enviados -join ", "))

  if ($Probar) { Write-Host "   [PROBAR] no se envía nada (copia preparada en $Temp)" -ForegroundColor Yellow; continue }

  ssh $m.Destino "rm -rf ~/hpc-instalar && mkdir -p ~/hpc-instalar"
  scp -q -r (Join-Path $Temp "*") "$($m.Destino):hpc-instalar/"
  ssh -t $m.Destino "chmod +x ~/hpc-instalar/instalar.sh && sudo ~/hpc-instalar/instalar.sh"
}

Write-Host "`nListo." -ForegroundColor Green
