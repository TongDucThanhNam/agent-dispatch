# Dot-source this file; it does not modify settings or the PowerShell profile.
function global:claude {
    $command = Get-Command claude.exe -CommandType Application -ErrorAction Stop
    $subcommands = @('agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin', 'plugins', 'project', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade')
    if (($args.Count -gt 0 -and $args[0] -in $subcommands) -or $args -contains '--tools') {
        & $command.Source @args
        return
    }
    & $command.Source --tools 'Bash,PowerShell,Read,Edit,Write,ToolSearch,WebFetch,WebSearch,Skill,AskUserQuestion' @args
}
