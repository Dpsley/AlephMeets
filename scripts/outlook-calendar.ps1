param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("status", "list", "upsert")]
  [string]$Action,
  [string]$From,
  [string]$To,
  [string]$PayloadBase64
)

$ErrorActionPreference = "Stop"

function Convert-Appointment($item) {
  return [ordered]@{
    externalEventId = [string]$item.EntryID
    subject = [string]$item.Subject
    body = [string]$item.Body
    location = [string]$item.Location
    startsAt = ([DateTime]$item.Start).ToUniversalTime().ToString("o")
    endsAt = ([DateTime]$item.End).ToUniversalTime().ToString("o")
    organizer = [string]$item.Organizer
  }
}

try {
  $outlook = New-Object -ComObject Outlook.Application
  $namespace = $outlook.GetNamespace("MAPI")

  if ($Action -eq "status") {
    [ordered]@{
      available = $true
      version = [string]$outlook.Version
    } | ConvertTo-Json -Compress
    exit 0
  }

  if ($Action -eq "list") {
    $calendar = $namespace.GetDefaultFolder(9)
    $items = $calendar.Items
    $items.IncludeRecurrences = $true
    $items.Sort("[Start]")

    $fromDate = [DateTime]::Parse($From).ToLocalTime()
    $toDate = [DateTime]::Parse($To).ToLocalTime()
    $filter = "[Start] >= '" + $fromDate.ToString("g") + "' AND [Start] < '" + $toDate.ToString("g") + "'"
    $result = @()
    foreach ($item in $items.Restrict($filter)) {
      if ($item.Class -eq 26) {
        $result += Convert-Appointment $item
      }
    }
    @($result) | ConvertTo-Json -Depth 4 -Compress
    exit 0
  }

  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64))
  $payload = $json | ConvertFrom-Json
  $appointment = $null
  if ($payload.externalEventId) {
    try { $appointment = $namespace.GetItemFromID($payload.externalEventId) } catch { $appointment = $null }
  }
  if ($null -eq $appointment) {
    $appointment = $outlook.CreateItem(1)
  }

  $appointment.Subject = $payload.subject
  $appointment.Body = $payload.body
  $appointment.Location = $payload.location
  $appointment.Start = [DateTime]::Parse($payload.startsAt).ToLocalTime()
  $appointment.End = [DateTime]::Parse($payload.endsAt).ToLocalTime()
  $appointment.MeetingStatus = 1
  foreach ($email in @($payload.attendees)) {
    if ($email) { [void]$appointment.Recipients.Add($email) }
  }
  [void]$appointment.Recipients.ResolveAll()
  $appointment.Save()
  Convert-Appointment $appointment | ConvertTo-Json -Depth 4 -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
