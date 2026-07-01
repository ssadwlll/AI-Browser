// ============ 域名安全策略 ============
// 管理白名单/黑名单/IP拦截，判断 URL 是否被允许访问
export class DomainPolicy {
  constructor(configService, scriptService) {
    this.configService = configService
    this.scriptService = scriptService
    this.allowedDomains = null
    this.prohibitedDomains = null
    this.blockIPAddresses = false
  }

  // 加载域名策略配置（每次 Agent run 开始时调用）
  async load() {
    try {
      const agentCfg = await this.configService.getAgentConfig()
      const allowed = agentCfg?.allowedDomains
      const prohibited = agentCfg?.prohibitedDomains
      // 未设置时保持 null，跳过检查
      this.allowedDomains = (allowed && allowed.length > 0) ? allowed : null
      this.prohibitedDomains = (prohibited && prohibited.length > 0) ? prohibited : null
      this.blockIPAddresses = !!agentCfg?.blockIPAddresses
    } catch {
      this.allowedDomains = null
      this.prohibitedDomains = null
      this.blockIPAddresses = false
    }
  }

  // 判断 URL 是否被允许
  isUrlAllowed(url) {
    // 未设置任何策略 → 全部放行
    if (!this.allowedDomains && !this.prohibitedDomains && !this.blockIPAddresses) return true

    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname

      // 禁止IP直连
      if (this.blockIPAddresses && /^[\d.]+$/.test(hostname)) return false

      // 白名单优先
      if (this.allowedDomains) {
        return this.allowedDomains.some(pattern => this._matchDomain(hostname, pattern))
      }
      // 黑名单
      if (this.prohibitedDomains) {
        return !this.prohibitedDomains.some(pattern => this._matchDomain(hostname, pattern))
      }
    } catch { return false }
    return true
  }

  // 域名匹配：支持 *.example.com、example.com（自动匹配 www 变体）
  _matchDomain(hostname, pattern) {
    const h = hostname.toLowerCase()
    const p = pattern.toLowerCase()
    // *.example.com → 匹配 sub.example.com 和 example.com
    if (p.startsWith('*.')) {
      const domainPart = p.slice(2)
      return h === domainPart || h.endsWith('.' + domainPart)
    }
    // 精确匹配 + www 变体
    if (h === p) return true
    if (h === 'www.' + p) return true
    if ('www.' + h === p) return true
    return false
  }

  // 判断 URL 是否匹配脚本的 urlPattern（用于 inject_script 过滤）
  matchUrlToDomain(pageUrl, urlPattern) {
    return this.scriptService.matchUrl(urlPattern, pageUrl)
  }
}
