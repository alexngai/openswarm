import { expect, it } from 'vitest'
import { inheritedRoute } from '../src/worktrees'

it("worktree members inherit the launcher's OpenAI-compatible route, and nothing else", () => {
  const launcher = {
    OPENSWARM_DEFAULT_PROVIDER: 'openai',
    OPENSWARM_LLM_BASE_URL: 'https://example.test/openai/v1',
    OPENSWARM_LLM_API_KEY: 'k',
    OPENSWARM_DEFAULT_MODEL: 'gpt-5.5',
  }
  expect(inheritedRoute(launcher)).toEqual({
    OPENSWARM_LLM_BASE_URL: 'https://example.test/openai/v1',
    OPENSWARM_LLM_API_KEY: 'k',
    DSH_MODEL: 'gpt-5.5',
  })
  // Members speak only the OpenAI-compatible route.
  expect(inheritedRoute({ ...launcher, OPENSWARM_DEFAULT_PROVIDER: 'bedrock' })).toEqual({})
  expect(inheritedRoute({})).toEqual({})
})
