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
export { createMapServer } from "./map-server.js";
export type { MapServer, CreateMapServerOptions } from "./map-server.js";
export { bridgeHostToMap } from "./map-bridge.js";
export type { MapBridgeOptions } from "./map-bridge.js";
export { createMacroMethods } from "./macro-methods.js";
export type { MacroMethods, CreateMacroMethodsOptions } from "./macro-methods.js";
export { registerCascadeActions } from "./cascade-actions.js";
export type { CascadeActionsDeps, CascadeRouter } from "./cascade-actions.js";
export { createMapSidecar } from "./map-sidecar.js";
export type { MapSidecar, MapSidecarOptions } from "./map-sidecar.js";
export { wireAcpOverMap } from "./map-acp-bridge.js";
export type { AcpOverMap, AcpOverMapOptions } from "./map-acp-bridge.js";
export { inboundMapSink } from "./map-bridge.js";
export type { MapSink } from "./map-bridge.js";
