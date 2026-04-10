[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [string]$RepoRoot,
  [string[]]$PreserveProfiles = @(
    'chrome_stable_manual_extension_profile',
    'cdp_sidebar_smoke'
  )
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedFullPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-IsChildPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ParentPath,
    [Parameter(Mandatory = $true)]
    [string]$ChildPath
  )

  if ($ChildPath.Length -le $ParentPath.Length) {
    return $false
  }

  return $ChildPath.StartsWith($ParentPath + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-IsChildPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ParentPath,
    [Parameter(Mandatory = $true)]
    [string]$ChildPath
  )

  if (-not (Test-IsChildPath -ParentPath $ParentPath -ChildPath $ChildPath)) {
    throw "Refusing to operate on path outside protected root. Parent='$ParentPath' Child='$ChildPath'"
  }
}

function Remove-ProtectedItem {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ProtectedRoot,
    [Parameter(Mandatory = $true)]
    [System.IO.FileSystemInfo]$Item
  )

  $resolvedItemPath = Get-NormalizedFullPath -Path $Item.FullName
  Assert-IsChildPath -ParentPath $ProtectedRoot -ChildPath $resolvedItemPath

  if ($PSCmdlet.ShouldProcess($resolvedItemPath, 'Remove-Item -Recurse -Force')) {
    Remove-Item -LiteralPath $resolvedItemPath -Recurse -Force
    Write-Host "Removed: $resolvedItemPath"
  } else {
    Write-Host "Would remove: $resolvedItemPath"
  }
}

# 说明：
# - 默认从当前脚本所在目录反推仓库根目录，避免依赖调用方当前工作目录；
# - 不用 $PSScriptRoot 做参数默认值，避免在某些调用方式下出现空值陷阱。
$scriptPath = $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($scriptPath)) {
  throw 'Unable to resolve script path.'
}

$scriptDir = Split-Path -Parent $scriptPath
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = Join-Path $scriptDir '..'
}

$resolvedRepoRoot = Get-NormalizedFullPath -Path $RepoRoot
$resolvedPlaywrightRoot = Get-NormalizedFullPath -Path (Join-Path $resolvedRepoRoot 'output\playwright')
$resolvedProfilesRoot = Get-NormalizedFullPath -Path (Join-Path $resolvedPlaywrightRoot '_profiles')

if (-not (Test-Path -LiteralPath $resolvedPlaywrightRoot)) {
  Write-Host "Nothing to clean: $resolvedPlaywrightRoot does not exist."
  exit 0
}

$normalizedPreserveProfiles = @()
foreach ($profileName in $PreserveProfiles) {
  if ([string]::IsNullOrWhiteSpace($profileName)) {
    continue
  }
  $trimmed = $profileName.Trim()
  if ($trimmed -match '[\\/:*?"<>|]') {
    throw "Invalid profile name in PreserveProfiles: '$trimmed'"
  }
  if (-not ($normalizedPreserveProfiles -contains $trimmed)) {
    $normalizedPreserveProfiles += $trimmed
  }
}

Write-Host "Repo root: $resolvedRepoRoot"
Write-Host "Playwright output root: $resolvedPlaywrightRoot"
Write-Host "Preserved profiles: $($normalizedPreserveProfiles -join ', ')"

# 说明：
# - 只删除 output/playwright 的直接子项；
# - 对 _profiles 目录单独处理：仅删除未被白名单保留的 profile 子目录；
# - 不会删除 _profiles 根目录本身，也不会碰 output/playwright 之外的任何路径。
$directChildren = Get-ChildItem -LiteralPath $resolvedPlaywrightRoot -Force
foreach ($child in $directChildren) {
  $resolvedChildPath = Get-NormalizedFullPath -Path $child.FullName
  Assert-IsChildPath -ParentPath $resolvedPlaywrightRoot -ChildPath $resolvedChildPath

  if ($child.Name -ieq '_profiles') {
    if (-not $child.PSIsContainer) {
      throw "_profiles exists but is not a directory: $resolvedChildPath"
    }

    $profileChildren = Get-ChildItem -LiteralPath $resolvedProfilesRoot -Force
    foreach ($profileChild in $profileChildren) {
      $resolvedProfilePath = Get-NormalizedFullPath -Path $profileChild.FullName
      Assert-IsChildPath -ParentPath $resolvedProfilesRoot -ChildPath $resolvedProfilePath

      if ($normalizedPreserveProfiles -contains $profileChild.Name) {
        Write-Host "Preserved profile: $resolvedProfilePath"
        continue
      }

      Remove-ProtectedItem -ProtectedRoot $resolvedProfilesRoot -Item $profileChild
    }

    continue
  }

  Remove-ProtectedItem -ProtectedRoot $resolvedPlaywrightRoot -Item $child
}

Write-Host 'Cleanup finished.'
