/**
 * TypeScript mirror of the `game_servers` map entry object type declared in
 * `terraform/variables.tf`. Keep the fields (and their optionality) in sync
 * with that Terraform variable — this is the shape parsed out of
 * `terraform.tfvars` by `TfvarsService`.
 */

/** Single TCP/UDP port a game server container listens on. */
export interface GameServerPort {
  container: number;
  protocol: string;
}

/** Environment variable injected into the game server container. */
export interface GameServerEnvironmentVariable {
  name: string;
  value: string;
}

/** EFS-backed volume mount for a game server container. */
export interface GameServerVolume {
  name: string;
  container_path: string;
}

/**
 * File seeded into the container filesystem at task start (e.g. server
 * config or mod files). Exactly one of `content` / `content_base64` is
 * normally supplied.
 */
export interface GameServerFileSeed {
  path: string;
  content?: string;
  content_base64?: string;
  mode?: string;
}

/**
 * Per-game container configuration, keyed by game name in the
 * `game_servers` Terraform variable (`terraform/variables.tf`).
 */
export interface GameServer {
  /**
   * The `game_servers` map key for this entry. Not a Terraform object
   * attribute — flattened onto the entry here so a list of `GameServer`
   * values is self-describing without a separate keys array.
   */
  name: string;
  image: string;
  cpu: number;
  memory: number;
  ports: GameServerPort[];
  environment?: GameServerEnvironmentVariable[];
  volumes: GameServerVolume[];
  https?: boolean;
  connect_message?: string;
  file_seeds?: GameServerFileSeed[];
}

/**
 * Response entry for the merged games list (the `games.list` IPC channel /
 * `/api/games` HTTP route). Combines the declared view (`terraform.tfvars`,
 * via {@link GameServer}) with the deployed view (`terraform.tfstate`) so
 * callers can tell "declared but not yet applied" apart from "live" games —
 * see issue #92.
 */
export interface GameListEntry {
  /**
   * Game key. Sourced from the tfvars `game_servers` map key when
   * `declared` is true, otherwise from the tfstate game name.
   */
  name: string;
  /** True when this game has an entry in the tfvars `game_servers` map. */
  declared: boolean;
  /** True when this game has a deployed ECS task definition in tfstate. */
  deployed: boolean;
  /**
   * Full tfvars-parsed configuration for this game. Only present when
   * `declared` is true.
   */
  config?: GameServer;
}
