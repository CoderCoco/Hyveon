# Fixture exercising terraform.tfvars entries where every optional
# `game_servers` field (`environment`, `https`, `connect_message`,
# `file_seeds`) is omitted entirely, leaving only the required fields
# (image, cpu, memory, ports, volumes).

aws_region   = "us-east-1"
project_name = "game-servers"

game_servers = {
  # Minecraft: only the required fields — no environment, https,
  # connect_message, or file_seeds.
  minecraft = {
    image  = "itzg/minecraft-server"
    cpu    = 1024
    memory = 2048
    ports = [
      { container = 25565, protocol = "tcp" },
    ]
    volumes = [
      { name = "world", container_path = "/data" },
    ]
  }

  # Terraria: a second entry, also with every optional field omitted.
  terraria = {
    image  = "ryshe/terraria"
    cpu    = 512
    memory = 1024
    ports = [
      { container = 7777, protocol = "tcp" },
    ]
    volumes = [
      { name = "world", container_path = "/config" },
    ]
  }
}
