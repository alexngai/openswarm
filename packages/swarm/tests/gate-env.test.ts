import { expect, it } from 'vitest'
import { gateEnv } from '../src/index'

it("the gate does not inherit the driver's npm invocation", () => {
  const env = gateEnv({
    PATH: '/bin',
    OPENSWARM_LIVE: '0',
    npm_config_allow_scripts: 'false',
    npm_lifecycle_event: 'test',
    NPM_CONFIG_CACHE: '/x',
    INIT_CWD: '/somewhere',
  })
  expect(env).toEqual({ PATH: '/bin', OPENSWARM_LIVE: '0' })
})
