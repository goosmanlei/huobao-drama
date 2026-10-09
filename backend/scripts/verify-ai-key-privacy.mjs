// 在临时数据库与模拟服务商中验证接口密钥边界；不读取正式 Key、不发起网络调用。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.argv[2])
const temp = mkdtempSync(join(tmpdir(), 'huobao-key-privacy-'))
process.env.SQLITE_PATH = join(temp, 'test.sqlite3')
process.env.MYSQL_AUTO_IMPORT = 'false'
const key = 'synthetic-fixture-key-for-privacy-test'
const replacement = 'synthetic-replacement-key'
let expectedKey = key
let upstreamCalls = 0
let throwFromUpstream = false
globalThis.fetch = async (url, options) => {
  upstreamCalls++
  assert.equal(options.headers.Authorization, `Bearer ${expectedKey}`)
  if (throwFromUpstream) throw new Error(`provider error: ${expectedKey}`)
  return new Response(`provider echo: ${expectedKey}`, { status: 200 })
}

try {
  const { default: app } = await import(pathToFileURL(join(repo, 'backend/src/routes/aiConfigs.ts')))
  const request = async (method, path, body) => {
    const response = await app.request(`http://localhost${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    assert.ok(!text.includes(key) && !text.includes(replacement), 'response leaked API key')
    return { status: response.status, body: JSON.parse(text) }
  }
  const config = { service_type: 'text', provider: 'openai', base_url: 'https://fixture.invalid', model: ['fixture'], api_key: key }
  const created = await request('POST', '/', config)
  assert.equal(created.status, 201)
  const id = created.body.data.id
  assert.equal(created.body.data.has_api_key, true)
  assert.ok(!('api_key' in created.body.data))
  for (const path of ['/', `/${id}`]) {
    const result = await request('GET', path)
    const items = Array.isArray(result.body.data) ? result.body.data : [result.body.data]
    assert.ok(items.every(item => item.has_api_key && !('api_key' in item)))
  }
  const testBody = { ...config, config_id: id, api_key: '' }
  await request('PUT', `/${id}`, { name: 'renamed', api_key: '   ' })
  assert.equal((await request('POST', '/test', testBody)).body.data.ok, true)
  const callsBefore = upstreamCalls
  assert.equal((await request('POST', '/test', { ...testBody, base_url: 'https://another.invalid' })).status, 400)
  assert.equal(upstreamCalls, callsBefore)
  throwFromUpstream = true
  const errorResult = await request('POST', '/test', testBody)
  assert.equal(errorResult.body.data.ok, false)
  throwFromUpstream = false
  await request('PUT', `/${id}`, { api_key: replacement })
  expectedKey = replacement
  assert.equal((await request('POST', '/test', testBody)).body.data.ok, true)
  console.log(JSON.stringify({ passed: true, checks: ['create/list/detail omit key', 'blank update preserves key', 'server-side probe reuses key', 'changed probe target rejected', 'upstream key echo and errors redacted', 'explicit replacement works'], external_requests: 0 }))
} finally {
  rmSync(temp, { recursive: true, force: true })
}
