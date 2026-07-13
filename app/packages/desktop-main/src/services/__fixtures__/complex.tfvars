# Complex fixture exercising every advanced tfvars construct TfvarsService
# must handle: line comments (#/`//`), a block comment, heredocs, file_seeds
# (text + base64 content), multiple volumes, multiple games, and Terraform
# expressions (arithmetic, a for-expression, a ternary, and a function call).

aws_region   = "us-east-1" # trailing comment
project_name = "game-servers"

/*
  Block comment describing the game_servers map below.
  Two games cover distinct construct combinations.
*/
game_servers = {
  # Palworld: full-featured entry — heredoc + base64 file_seeds, multiple
  # volumes, https, connect_message.
  palworld = {
    image  = "thijsvanloef/palworld-server-docker:latest"
    cpu    = 2048
    memory = 8192
    ports = [
      { container = 8211, protocol = "udp" },
      { container = 27015, protocol = "udp" },
    ]
    environment = [
      { name = "PLAYERS", value = "16" },
      { name = "SERVER_NAME", value = "My Palworld Server" },
    ]
    volumes = [
      { name = "saves", container_path = "/palworld" },
      { name = "mods", container_path = "/palworld/mods" },
    ]
    https           = false
    connect_message = "Connect to {host}:{port}"

    # file_seeds: heredoc text content plus a base64-encoded binary mod file.
    file_seeds = [
      {
        path    = "/palworld/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini"
        content = <<-INI
          [/Script/Pal.PalGameWorldSettings]
          OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.0,NightTimeSpeedRate=1.0)
        INI
      },
      {
        path           = "/palworld/Pal/Content/Paks/MyMod.pak"
        content_base64 = "UEsDBBQAAAAIAAAAIQAAAAAAAAAAAAAAAAAA"
        mode           = "0644"
      },
    ]
  }

  // Valheim: exercises Terraform expressions — arithmetic, a for-expression
  // building the ports list, a ternary, and a format() call.
  valheim = {
    image  = "lloesche/valheim-server"
    cpu    = 1024 * 2
    memory = 4096 + 2048
    ports  = [for p in [2456, 2457, 2458] : { container = p, protocol = "udp" }]
    environment = [
      { name = "SERVER_NAME", value = format("%s-valheim", "hyveon") },
    ]
    volumes = [
      { name = "saves", container_path = "/config" },
    ]
    https           = length("valheim") > 0 ? true : false
    connect_message = format("Connect via %s", "the Discord bot")
  }
}
