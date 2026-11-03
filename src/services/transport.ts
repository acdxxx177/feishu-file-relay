type FeishuTransportEnv = Pick<Env, 'FEISHU_API_BASE' | 'FEISHU_ACCOUNTS_BASE' | 'FEISHU_MOCK'> & {
  FEISHU_TRANSPORT?: string
}

export function feishuFetch(env: FeishuTransportEnv, input: URL, init: RequestInit): Promise<Response> {
  if (env.FEISHU_TRANSPORT === undefined || env.FEISHU_TRANSPORT === 'real') {
    // 发现模拟绑定或模拟域名却缺少模式开关时同样拒绝，避免测试配置拼接错误触达公网。
    if (env.FEISHU_MOCK || env.FEISHU_API_BASE === 'https://mock-feishu.invalid' || env.FEISHU_ACCOUNTS_BASE === 'https://mock-accounts.invalid') throw new Error('Ambiguous Feishu transport configuration')
    return fetch(input, init)
  }
  if (env.FEISHU_TRANSPORT !== 'mock') throw new Error('Unsupported Feishu transport')
  // 测试环境必须闭合在私有绑定内；配置错误不能悄悄触达真实飞书。
  if (!env.FEISHU_MOCK || env.FEISHU_API_BASE !== 'https://mock-feishu.invalid' || env.FEISHU_ACCOUNTS_BASE !== 'https://mock-accounts.invalid') {
    throw new Error('Incomplete mock transport configuration')
  }
  if (input.origin !== env.FEISHU_API_BASE && input.origin !== env.FEISHU_ACCOUNTS_BASE) throw new Error('Invalid mock origin')
  return env.FEISHU_MOCK.fetch(new Request(input, init))
}
