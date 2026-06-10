/**
 * host/ — docs/44 Track B (OpenHive hosting). Public surface for the swarm
 * host entrypoint: boot + health + bootstrap-contract parsing.
 */

export { bootSwarmHost } from "./boot.js";
export type {
  SwarmHostHandle,
  SwarmHostPorts,
  BootSwarmHostOptions,
} from "./boot.js";
export { createHealthServer } from "./health.js";
export type { HealthServer, CreateHealthServerOptions } from "./health.js";
export { readBootstrapConfig } from "./bootstrap.js";
export type { BootstrapConfig, RehydratePolicy } from "./bootstrap.js";
export { createAcpWsServer } from "./acp-ws-server.js";
export type {
  AcpWsServer,
  AcpConnection,
  CreateAcpWsServerOptions,
} from "./acp-ws-server.js";
