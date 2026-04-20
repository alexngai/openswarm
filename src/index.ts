export const VERSION = "0.0.1";

export function greet(name = "world"): string {
  return `Hello, ${name}! swarm-coder v${VERSION}`;
}
