// GEO AI发布助手 - AI提供者模块 (GEO_SHARED_CONSTANTS + coze + dmx + mock)

const GEO_SHARED_CONSTANTS = {
  VALID_SCHEMA_TYPES: ['Person', 'Organization', 'Place', 'CreativeWork', 'Periodical', 'CollegeOrUniversity', 'ResearchOrganization', 'Thing'],
  SCHEMA_TYPES_REGEX: '(Person|Organization|Place|CreativeWork|Periodical|CollegeOrUniversity|ResearchOrganization|Thing)',
  AUTHOR_ROLES_REGEX: '^(记者|通讯员|摄影|编辑|见习记者|本报记者)\\s+(.+)$',
  DEFAULT_TEMPLATE_ID: 'basic_fact_card',
  DEFAULT_TEMPLATE_NAME: '基础新闻事实卡',
  TAG_PATTERNS: [
    { keywords: ['会议', '座谈', '研讨', '论坛'], tag: '会议' },
    { keywords: ['项目', '开工', '竣工', '投产'], tag: '项目' },
    { keywords: ['民生', '就业', '医疗', '教育'], tag: '民生' },
    { keywords: ['文化', '旅游', '景区', '公园'], tag: '文旅' },
    { keywords: ['经济', '产业', '企业', '投资'], tag: '经济' },
    { keywords: ['安全', '生产', '消防', '应急'], tag: '安全' },
    { keywords: ['党建', '党史', '党员'], tag: '党建' },
    { keywords: ['乡村', '农村', '振兴'], tag: '乡村振兴' }
  ]
};

const GeoCozeProvider = {
  POLL_INTERVAL: 3000,
  MAX_POLL_TIME: 120000,

  get PROXY_API() {
    return (window.GEO_CONFIG && window.GEO_CONFIG.cozeApiUrl) || 'https://phpdev.66wz.com/api/coze-proxy.php';
  },
  get _apiBaseUrl() {
    return (window.GEO_CONFIG && window.GEO_CONFIG.apiBaseUrl) || 'https://phpdev.66wz.com/api';
  },
  set _apiBaseUrl(val) {
    // 兼容旧代码的setter，实际值从GEO_CONFIG读取
  },

  /**
   * 生成AppKey签名请求头
   * 算法：HMAC-SHA256(appKey + timestamp, appSecret)
   * 与 coze-proxy.php 服务端验证逻辑一致
   */
  _buildAuthHeaders() {
    const config = window.GEO_CONFIG || {};
    const appKey = config.cozeAppKey || '';
    const appSecret = config.cozeAppSecret || '';
    const headers = { 'Content-Type': 'application/json' };
    if (appKey && appSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const message = appKey + timestamp;
      headers['X-App-Key'] = appKey;
      headers['X-Timestamp'] = timestamp;
      headers['X-Sign'] = this._hmacSha256(appSecret, message);
    }
    return headers;
  },

  /**
   * 纯 JS HMAC-SHA256 实现（兼容 HTTP 页面，不依赖 crypto.subtle）
   * 算法：HMAC(K, m) = SHA256((K⊕opad) || SHA256((K⊕ipad) || m))
   */
  _hmacSha256(key, message) {
    const _s2b = this._strToBytes;
    const _sha = this._sha256;
    const blockSize = 64;
    let keyArr = typeof key === 'string' ? _s2b(key) : key.slice();
    if (keyArr.length > blockSize) keyArr = _sha(keyArr);
    while (keyArr.length < blockSize) keyArr.push(0);
    const ipad = keyArr.map(b => b ^ 0x36);
    const opad = keyArr.map(b => b ^ 0x5c);
    const msgArr = typeof message === 'string' ? _s2b(message) : message;
    const inner = _sha(ipad.concat(msgArr));   // 返回原始字节数组
    return _sha(opad.concat(inner)).map(b => b.toString(16).padStart(2, '0')).join('');
  },

  _strToBytes(str) {
    const arr = [];
    for (let i = 0; i < str.length; i++) arr.push(str.charCodeAt(i) & 0xFF);
    return arr;
  },

  /**
   * 纯 JS SHA-256，返回 32 字节原始数组
   * 基于 FIPS 180-4 / RFC 6234 参考实现
   */
  _sha256(msg) {
    const src = (typeof msg === 'string' ? this._strToBytes(msg) : msg).slice();
    const bitLen = src.length * 8;
    src.push(0x80);
    while ((src.length % 64) !== 56) src.push(0);
    for (let i = 56; i >= 0; i -= 8) src.push((bitLen / Math.pow(2, i)) & 0xff);

    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const rr = (n, d) => (n >>> d) | (n << (32 - d));

    for (let off = 0; off < src.length; off += 64) {
      const w = [];
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        w[i] = (src[j] << 24) | (src[j+1] << 16) | (src[j+2] << 8) | src[j+3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i-15],7) ^ rr(w[i-15],18) ^ (w[i-15]>>>3);
        const s1 = rr(w[i-2],17) ^ rr(w[i-2],19) ^ (w[i-2]>>>10);
        w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
      }
      let [a,b,c,d,e,f,g,h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rr(e,6) ^ rr(e,11) ^ rr(e,25);
        const ch = (e&f) ^ (~e&g);
        const t1 = (h+S1+ch+K[i]+w[i]) | 0;
        const S0 = rr(a,2) ^ rr(a,13) ^ rr(a,22);
        const maj = (a&b) ^ (a&c) ^ (b&c);
        const t2 = (S0+maj) | 0;
        h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
      }
      H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
      H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
    }
    return H.flatMap(v => [(v>>>24)&0xff, (v>>>16)&0xff, (v>>>8)&0xff, v&0xff]);
  },

  async init() {
    return true;
  },

  async completePublishInfo(content) {
    try {
      const result = await this._runWorkflow(content, '', 'complete');
      return result;
    } catch (error) {
      console.error('Coze调用失败，回退到Mock模式:', error);
      return GeoMockProvider.completePublishInfo(content);
    }
  },

  async _runWorkflow(content, title, task) {
    const result = await this._submitWorkflow(content, title, task);

    if (result.data) {
      return this._parseOutput(result.data, task);
    }

    if (result.execute_id) {
      const output = await this._pollResult(result.execute_id);
      return this._parseOutput(output, task);
    }

    throw new Error('工作流未返回有效结果');
  },

  async _submitWorkflow(content, title, task) {
    const body = { content: content, task: task || 'complete' };
    if (title) body.title = title;

    const response = await fetch(this.PROXY_API, {
      method: 'POST',
      headers: this._buildAuthHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `代理接口请求失败: ${response.status}`;
      try {
        const errorData = JSON.parse(errorText);
        errorMsg = errorData.error || errorMsg;
      } catch (e) {}
      throw new Error(errorMsg);
    }

    const result = await response.json();

    if (result.code !== 0) {
      throw new Error(`Coze工作流提交失败: ${result.msg || '未知错误'}`);
    }

    return {
      data: result.data || '',
      execute_id: result.execute_id || '',
      token: result.token || 0,
      debug_url: result.debug_url || ''
    };
  },

  async _pollResult(executeId) {
    const startTime = Date.now();

    while (Date.now() - startTime < this.MAX_POLL_TIME) {
      try {
        const response = await fetch(
          `${this.PROXY_API}?execute_id=${encodeURIComponent(executeId)}`,
          {
            method: 'GET',
            headers: this._buildAuthHeaders()
          }
        );

        if (!response.ok) {
          console.warn('轮询请求失败，继续重试...');
          await this._delay(this.POLL_INTERVAL);
          continue;
        }

        const history = await response.json();

        if (!history.data || history.data.length === 0) {
          console.log('暂无数据返回，继续查询...');
          await this._delay(this.POLL_INTERVAL);
          continue;
        }

        const status = history.data[0].execute_status;
        console.log('工作流状态:', status);

        if (status === 'Success') {
          const usage = history.data[0].usage || {};
          console.log('Token消耗:', usage);
          return history.data[0].output || '';
        }

        if (status === 'Failed') {
          const errorMsg = history.data[0].error_message || '未知错误';
          throw new Error(`工作流执行失败: ${errorMsg}`);
        }

        await this._delay(this.POLL_INTERVAL);

      } catch (error) {
        if (error.message.includes('工作流执行失败')) {
          throw error;
        }
        console.warn('轮询异常:', error.message);
        await this._delay(this.POLL_INTERVAL);
      }
    }

    throw new Error('工作流执行超时');
  },

  _parseOutput(outputStr, task) {
    if (!outputStr) {
      throw new Error('工作流输出为空');
    }

    let layer1;
    try {
      layer1 = JSON.parse(outputStr);
    } catch (e) {
      throw new Error('输出JSON解析失败: ' + e.message);
    }

    const outputInner = layer1.Output || layer1.output || '';
    if (!outputInner) {
      if (layer1.summary || layer1.templateId) {
        return this._buildResult(layer1, task);
      }
      throw new Error('Output字段为空，请检查Coze工作流输出节点配置');
    }

    let rawOutput = '';
    if (typeof outputInner === 'string' && outputInner.trim().startsWith('```')) {
      rawOutput = outputInner;
    } else {
      let layer2;
      try {
        layer2 = typeof outputInner === 'string' ? JSON.parse(outputInner) : outputInner;
      } catch (e) {
        throw new Error('输出嵌套JSON解析失败: ' + e.message);
      }
      rawOutput = layer2.output || layer2.Output || '';
      if (!rawOutput) {
        if (layer2.summary || layer2.templateId) {
          return this._buildResult(layer2, task);
        }
        throw new Error('内层output字段为空');
      }
    }

    let jsonStr = rawOutput.trim();
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '');
    jsonStr = jsonStr.replace(/\n?```\s*$/i, '');
    jsonStr = jsonStr.trim();

    let outputData;
    try {
      outputData = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error('输出JSON解析失败: ' + e.message);
    }

    return this._buildResult(outputData, task);
  },

  _buildResult(outputData, task) {
    return {
      templateId: outputData.templateId || 'basic_fact_card',
      templateName: outputData.templateName || '基础新闻事实卡',
      confidence: outputData.confidence || 0.8,
      classifyReason: outputData.classifyReason || '',
      fields: Array.isArray(outputData.fields) ? outputData.fields : [],
      title: outputData.title || '',
      summary: outputData.summary || '',
      keywords: Array.isArray(outputData.keywords) ? outputData.keywords : [],
      introduction: outputData.introduction || '',
      tags: Array.isArray(outputData.tags) ? outputData.tags : [],
      entities: Array.isArray(outputData.entities) ? outputData.entities.map(e => {
        if (typeof e === 'object' && e !== null) return e;
        if (typeof e === 'string') return { name: e, type: 'Thing' };
        return e;
      }) : [],
      authors: Array.isArray(outputData.authors) ? outputData.authors.map(a => {
        if (typeof a === 'object' && a !== null) return a;
        if (typeof a === 'string') {
          const match = a.match(/^(记者|通讯员|摄影|编辑|见习记者|本报记者)\s+(.+)$/);
          if (match) return { role: match[1], name: match[2] };
          return { role: '', name: a };
        }
        return a;
      }) : [],
      qa: Array.isArray(outputData.qa) ? outputData.qa : [],
      eventDate: outputData.eventDate || '',
      eventDate_evidence: outputData.eventDate_evidence || '',
      location: outputData.location || '',
      location_evidence: outputData.location_evidence || '',
      keyFact: outputData.keyFact || '',
      eventName: outputData.eventName || '',
      organizer: outputData.organizer || '',
      participants: Array.isArray(outputData.participants) ? outputData.participants.map(p => {
        if (typeof p === 'object' && p !== null) return p;
        if (typeof p === 'string') {
          const m = p.match(/^(.+)\((Organization|Person|Thing)\)$/);
          if (m) return { name: m[1], type: m[2] };
          return { name: p, type: 'Organization' };
        }
        return p;
      }) : (outputData.participants || ''),
      result: outputData.result || '',
      scale: outputData.scale || '',
      eventLink: outputData.eventLink || '',
      leaderName: outputData.leaderName || '',
      leaderName_evidence: outputData.leaderName_evidence || '',
      leaderTitle: outputData.leaderTitle || '',
      activityType: outputData.activityType || '',
      speechHighlights: outputData.speechHighlights || '',
      attendees: outputData.attendees || '',
      keyDecision: outputData.keyDecision || '',
      eventDescription: outputData.eventDescription || '',
      casualty: outputData.casualty || '',
      impact: outputData.impact || '',
      response: outputData.response || '',
      reminder: outputData.reminder || '',
      institution: (typeof outputData.institution === 'object' && outputData.institution !== null) ? outputData.institution : { name: outputData.institution || '', type: 'Organization' },
      researchField: outputData.researchField || '',
      achievement: outputData.achievement || '',
      significance: outputData.significance || '',
      keyPerson: Array.isArray(outputData.keyPerson) ? outputData.keyPerson.map(p => {
        if (typeof p === 'object' && p !== null) return p;
        if (typeof p === 'string') {
          const m = p.match(/^(.+)\((Person|Organization|Thing)\)$/);
          if (m) return { name: m[1], type: m[2] };
          return { name: p, type: 'Person' };
        }
        return p;
      }) : (outputData.keyPerson || ''),
      dataSupport: outputData.dataSupport || '',
      industry: outputData.industry || '',
      dataIndicator: outputData.dataIndicator || '',
      trend: outputData.trend || '',
      policyImpact: outputData.policyImpact || '',
      keyEntity: Array.isArray(outputData.keyEntity) ? outputData.keyEntity.map(e => {
        if (typeof e === 'object' && e !== null) return e;
        if (typeof e === 'string') {
          const m = e.match(/^(.+)\((Organization|CreativeWork|Thing|Person)\)$/);
          if (m) return { name: m[1], type: m[2] };
          return { name: e, type: 'Organization' };
        }
        return e;
      }) : (outputData.keyEntity || ''),
      comparison: outputData.comparison || ''
    };
  },

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};

const GeoDmxProvider = {
  MODELS: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（快速）' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（高质量）' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
    { id: 'qwen3.6-27b', name: 'Qwen3.6-27B' },
    { id: 'qwen3.6-flash', name: 'Qwen3.6 Flash（快速）' }
  ],

  DEFAULT_MODEL: 'deepseek-v4-pro',
  _selectedModel: null,

  get API_URL() {
    return (window.GEO_CONFIG && window.GEO_CONFIG.dmxApiUrl) || 'https://www.dmxapi.cn/v1/chat/completions';
  },

  get API_KEY() {
    return (window.GEO_CONFIG && window.GEO_CONFIG.dmxApiKey) || '';
  },

  async init() {
    try {
      const config = window.GEO_CONFIG || {};
      if (config.dmxModel === 'custom' && config.dmxCustomModel) {
        this._selectedModel = config.dmxCustomModel;
      } else {
        this._selectedModel = config.dmxModel || this.DEFAULT_MODEL;
      }
    } catch (e) {
      this._selectedModel = this.DEFAULT_MODEL;
    }
    return true;
  },

  getModel() {
    return this._selectedModel || this.DEFAULT_MODEL;
  },

  async completePublishInfo(content) {
    try {
      const result = await this._callModel(content);
      return result;
    } catch (error) {
      console.error('DMX调用失败，回退到Mock模式:', error);
      const mockResult = await GeoMockProvider.completePublishInfo(content);
      mockResult._fallbackToMock = true;
      mockResult._fallbackReason = error.message;
      return mockResult;
    }
  },

  async _buildPrompt(content) {
    let promptTemplate = this._getDefaultPrompt();

    const { templateList, requiredFields } = this._generateTemplateInfoSync();

    let prompt = promptTemplate
      .replace('{{content}}', content)
      .replace('{{template_list}}', templateList)
      .replace('{{required_fields}}', requiredFields);

    return prompt;
  },

  _generateTemplateInfoSync() {
    let templateList = '';
    let requiredFields = '';
    const options = (typeof TEMPLATE_OPTIONS !== 'undefined') ? TEMPLATE_OPTIONS : [];
    if (options.length > 0) {
      const tplTableLines = ['| 模板ID | 名称 | 适用场景 |', '|--------|------|----------|'];
      const matchRules = ['- 根据标题和正文内容判断最合适的知识卡片模板', '- 给出置信度（0-1之间的数值）和推荐理由', '- 识别规则（按优先级从高到低）：'];
      const reqTableLines = ['| 模板ID | 必填字段 | 说明 |', '|--------|----------|------|'];
      options.forEach(opt => {
        const tpl = (TEMPLATE_CONFIG && TEMPLATE_CONFIG.templates) ? TEMPLATE_CONFIG.templates.find(t => t.id === opt.id) : null;
        tplTableLines.push('| ' + opt.id + ' | ' + opt.name + ' | ' + (tpl && tpl.applicableScenarios || '') + ' |');
        if (tpl && tpl.matchRules && tpl.matchRules.keywords && tpl.matchRules.keywords.length > 0) {
          matchRules.push('  - 包含"' + tpl.matchRules.keywords.join('/') + '"等关键词 → ' + opt.id);
        } else {
          matchRules.push('  - 其他 → ' + opt.id);
        }
        const reqFields = (opt.fields || []).filter(f => f.required);
        reqTableLines.push('| ' + opt.id + ' | ' + reqFields.map(f => f.key).join(', ') + ' | ' + reqFields.map(f => f.label).join('、') + ' |');
      });
      matchRules.push('- **优先级原则**：当多个模板都可能匹配时，选择能抽取更多结构化字段的模板。');
      templateList = tplTableLines.join('\n') + '\n\n' + matchRules.join('\n');
      requiredFields = reqTableLines.join('\n');
    }
    return { templateList, requiredFields };
  },

  _getDefaultPrompt() {
    return `# 角色
你是一个专业的新闻内容结构化助手，专注于从新闻正文中自动提取并生成标准化的新闻发布补充信息，同时识别内容类型、匹配知识卡片模板，并抽取结构化字段数据。你需要严格依据新闻正文的事实内容，以客观、准确、简洁的语言完成以下信息的结构化处理，为新闻发布提供清晰、规范的辅助内容。

## 输入
正文：{{content}}

## 知识卡片模板类型

{{template_list}}

## 技能

### 技能 1: 内容类型识别
- 根据标题和正文内容判断最合适的知识卡片模板
- 给出置信度（0-1之间的数值）和推荐理由
- 置信度低于0.6时默认使用basic_fact_card

### 技能 2: 标题生成
- 基于新闻正文核心事件、时间、地点或人物，生成15-30字的标题

### 技能 3: 摘要提炼
- 用100-150字概括新闻核心内容，确保客观中立

### 技能 4: 关键词提取
- 提取5个最具代表性的关键词

### 技能 5: 导读撰写
- 创作50-80字的导读内容

### 技能 6: 主题标签选择
- 选择3个与内容高度相关的主题标签

### 技能 7: 核心实体识别
- 识别3-5个核心实体，标注类型

### 技能 8: 常见问答（QA）生成
- 生成2组问答，附带原文依据

### 技能 9: 作者提取
- 提取所有作者信息

### 技能 10: 模板字段抽取
{{required_fields}}

## 输出格式
严格按照以下JSON模板输出结果，不得包含任何额外文本说明：
\`\`\`json
{
  "templateId": "模板ID",
  "templateName": "模板中文名称",
  "confidence": 0.85,
  "classifyReason": "推荐理由",
  "fields": [
    {"key": "字段key", "label": "字段中文名", "required": true, "value": "字段值", "evidence": "原文依据"}
  ],
  "title": "标题",
  "summary": "摘要",
  "keywords": ["关键词1", "关键词2", "关键词3", "关键词4", "关键词5"],
  "introduction": "导读",
  "tags": ["标签1", "标签2", "标签3"],
  "entities": [{"name": "实体名", "type": "Person|Organization|Place|CreativeWork|Periodical|Thing"}],
  "authors": [{"role": "身份", "name": "姓名"}],
  "qa": [
    {"q": "问题", "a": "回答", "evidence": "原文依据"}
  ]
}
\`\`\`

## 限制条件
1. 所有信息必须严格基于输入的新闻正文，不得编造或篡改
2. 输出语言需正式、客观
3. 字数限制：标题不超过30字，摘要不超过150字
4. 正文中未提及的信息留空字符串""
5. 通用字段必须全部输出`;
  },

  async _callModel(content) {
    const model = this.getModel();
    const prompt = await this._buildPrompt(content);

    console.group('%c[GEO-DMX] 发送给大模型的内容', 'color: #4CAF50; font-weight: bold;');
    console.log('模型:', model);
    console.log('提示词长度:', prompt.length, '字符');
    console.log('完整提示词:', prompt);
    console.log('正文内容:', content);
    console.groupEnd();

    const requestBody = {
      model: model,
      messages: [
        {
          role: 'system',
          content: '你是一个专业的新闻内容结构化助手。严格按照要求的JSON格式输出，不要包含任何额外文本。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 4000,
      thinking: { type: 'disabled' },
      stream: true
    };

    console.log('[GEO-DMX] 请求体:', { ...requestBody, stream: true });

    const startTime = Date.now();
    const response = await fetch(this.API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.API_KEY}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = `DMX API请求失败: ${response.status}`;
      try {
        const errorData = JSON.parse(errorText);
        errorMsg = errorData.error?.message || errorData.error || errorMsg;
      } catch (e) {}
      throw new Error(errorMsg);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let buffer = '';
    let firstTokenTime = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta?.content || '';
          if (delta) {
            if (!firstTokenTime) {
              firstTokenTime = Date.now() - startTime;
              console.log(`[GEO-DMX] 首字耗时: ${firstTokenTime}ms`);
            }
            fullContent += delta;
          }
        } catch (e) {
          // 忽略解析错误的chunk
        }
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`[GEO-DMX] 流式总耗时: ${totalTime}ms, 内容长度: ${fullContent.length}`);

    if (!fullContent) {
      throw new Error('DMX API返回内容为空');
    }

    return this._parseOutput(fullContent);
  },

  _parseOutput(outputStr) {
    if (!outputStr) {
      throw new Error('模型输出为空');
    }

    let jsonStr = outputStr.trim();

    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/i, '');
    jsonStr = jsonStr.replace(/\n?```\s*$/i, '');
    jsonStr = jsonStr.trim();

    jsonStr = jsonStr
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');

    let outputData;
    try {
      outputData = JSON.parse(jsonStr);
    } catch (firstError) {
      console.warn('[GEO-DMX] JSON首次解析失败，尝试修复...', firstError.message);

      const firstBrace = jsonStr.indexOf('{');
      const lastBrace = jsonStr.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        let subStr = jsonStr.substring(firstBrace, lastBrace + 1);
        try {
          outputData = JSON.parse(subStr);
        } catch (e2) {
          throw new Error('输出JSON解析失败: ' + firstError.message);
        }
      } else {
        throw new Error('输出JSON解析失败: ' + firstError.message);
      }
    }

    return this._buildResult(outputData);
  },

  _buildResult(outputData) {
    return GeoCozeProvider._buildResult(outputData, 'complete');
  }
};

const GeoMockProvider = {
  async completePublishInfo(content) {
    await this._delay(800 + Math.random() * 700);

    const title = this._generateTitle(content);
    const keywords = this._extractKeywords(content);
    const summary = this._generateSummary(content);
    const introduction = this._generateIntroduction(content);
    const tags = this._extractTags(content);
    const entities = this._extractEntities(content);
    const qa = this._generateQA(content, entities);
    const authors = this._extractAuthors(content);
    const classify = this._classifyContent(title, content);
    const cardFields = this._extractCardFields(classify.templateId, title, content);

    return {
      templateId: classify.templateId,
      templateName: classify.templateName || classify.templateId,
      confidence: classify.confidence,
      classifyReason: classify.reason,
      fields: cardFields._fields || [],
      title,
      summary,
      keywords,
      introduction,
      tags,
      entities,
      authors,
      qa
    };
  },

  _classifyContent(text) {
    const options = (typeof TEMPLATE_OPTIONS !== 'undefined') ? TEMPLATE_OPTIONS : [];
    const config = (typeof TEMPLATE_CONFIG !== 'undefined' && TEMPLATE_CONFIG) ? TEMPLATE_CONFIG : null;

    if (config && config.templates) {
      for (const tpl of config.templates) {
        const rules = tpl.matchRules;
        if (!rules || !rules.keywords || rules.keywords.length === 0) continue;
        if (tpl.id === 'basic_fact_card') continue;
        const pattern = new RegExp(rules.keywords.join('|'));
        if (pattern.test(text)) {
          return {
            templateId: tpl.id,
            templateName: tpl.name,
            confidence: 0.75 + Math.random() * 0.15,
            reason: '内容涉及' + (tpl.applicableScenarios || tpl.name)
          };
        }
      }
    } else {
      for (const opt of options) {
        if (opt.id === 'basic_fact_card') continue;
        if (opt.name && text.includes(opt.name.replace(/[（）()类新闻]/g, ''))) {
          return {
            templateId: opt.id,
            templateName: opt.name,
            confidence: 0.7 + Math.random() * 0.15,
            reason: '内容涉及' + opt.name
          };
        }
      }
    }

    return {
      templateId: 'basic_fact_card',
      templateName: '基础新闻事实卡',
      confidence: 0.6 + Math.random() * 0.2,
      reason: '通用新闻事实，使用基础新闻事实卡'
    };
  },

  _extractCardFields(templateId, title, content) {
    const date = this._extractDate(content) || '';
    const dateEvidence = this._extractDateEvidence(content);
    const location = this._extractLocation(content) || '';
    const locationEvidence = this._extractLocationEvidence(content);
    const organizer = this._extractOrganizer(content) || '';

    const options = (typeof TEMPLATE_OPTIONS !== 'undefined') ? TEMPLATE_OPTIONS : [];
    const tplOption = options.find(o => o.id === templateId);
    const fields = tplOption ? tplOption.fields : [
      { key: 'eventDate', label: '事件日期', required: false },
      { key: 'location', label: '地点', required: false },
      { key: 'keyFact', label: '核心事实', required: false }
    ];

    const FIELD_DEFAULTS = {
      eventDate: () => date,
      location: () => location,
      organizer: () => organizer,
      institution: () => organizer ? { name: organizer, type: 'Organization' } : { name: '', type: 'Organization' },
      participants: () => [],
      keyPerson: () => [],
      keyEntity: () => [],
      attendees: () => [],
      eventDescription: () => this._truncate(content, 100),
      trend: () => this._truncate(content, 100),
      achievement: () => this._truncate(content, 100),
      speechHighlights: () => this._truncate(content, 100),
    };

    const FIELD_EVIDENCE = {
      eventDate: dateEvidence,
      location: locationEvidence,
    };

    const fieldValues = {};
    fields.forEach(f => {
      if (FIELD_DEFAULTS[f.key]) {
        fieldValues[f.key] = FIELD_DEFAULTS[f.key]();
      } else {
        fieldValues[f.key] = '';
      }
      if (FIELD_EVIDENCE[f.key]) {
        fieldValues[f.key + '_evidence'] = FIELD_EVIDENCE[f.key];
      }
    });

    const enrichedFields = fields.map(field => ({
      ...field,
      value: fieldValues[field.key] || '',
      evidence: fieldValues[field.key + '_evidence'] || ''
    }));

    fieldValues._fields = enrichedFields;
    return fieldValues;
  },

  _extractDate(content) {
    const patterns = [
      /(\d{4})年(\d{1,2})月(\d{1,2})日/,
      /(\d{4})\.(\d{1,2})\.(\d{1,2})/,
      /(\d{4})-(\d{1,2})-(\d{1,2})/
    ];
    for (const p of patterns) {
      const m = content.match(p);
      if (m) return m[0];
    }
    return '';
  },

  _extractDateEvidence(content) {
    const date = this._extractDate(content);
    if (!date) return '';
    const idx = content.indexOf(date);
    const start = Math.max(0, idx - 10);
    const end = Math.min(content.length, idx + date.length + 10);
    return '原文："' + content.substring(start, end) + '"';
  },

  _extractLocation(content) {
    const m = content.match(/([^\s]{2,8}(?:市|县|区|镇|路|街|广场|中心|馆|园|院))/);
    return m ? m[1] : '';
  },

  _extractLocationEvidence(content) {
    const loc = this._extractLocation(content);
    if (!loc) return '';
    const idx = content.indexOf(loc);
    const start = Math.max(0, idx - 8);
    const end = Math.min(content.length, idx + loc.length + 8);
    return '原文："' + content.substring(start, end) + '"';
  },

  _extractOrganizer(content) {
    const m = content.match(/([^\s]{2,10}(?:局|委|办|厅|部|会|中心|集团|公司|协会|基金会))/);
    return m ? m[1] : '';
  },

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  _truncate(text, maxLength) {
    if (!text) return '';
    const plain = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (plain.length <= maxLength) return plain;
    return plain.substring(0, maxLength - 3) + '...';
  },

  _generateTitle(content) {
    const plain = this._truncate(content, 200);
    const sentences = plain.split(/[。！？]/);
    const first = sentences[0] || '';
    if (first.length <= 30) return first;
    return first.substring(0, 28) + '…';
  },

  _extractKeywords(content) {
    const allText = content || '';
    const words = allText.match(/[\u4e00-\u9fa5]{2,4}/g) || [];

    const freq = {};
    words.forEach(w => {
      if (w.length >= 2) {
        freq[w] = (freq[w] || 0) + 1;
      }
    });

    const sorted = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(item => item[0]);

    return sorted.length > 0 ? sorted : ['新闻', '资讯'];
  },

  _generateSummary(content) {
    const plain = this._truncate(content, 200);
    if (plain.length < 50) return plain;

    const sentences = plain.split(/[。！？]/);
    if (sentences.length >= 2) {
      return sentences.slice(0, 2).join('。') + '。';
    }
    return this._truncate(plain, 100);
  },

  _generateIntroduction(content) {
    return `本文围绕${this._truncate(content, 15)}展开，${this._truncate(content, 80)}...`;
  },

  _extractTags(content) {
    const allText = content || '';
    const tags = [];

    let tagPatterns;
    if (typeof GEO_SHARED_CONSTANTS !== 'undefined' && GEO_SHARED_CONSTANTS.TAG_PATTERNS) {
      tagPatterns = GEO_SHARED_CONSTANTS.TAG_PATTERNS.map(tp => ({
        pattern: new RegExp(tp.keywords.join('|'), 'g'),
        tag: tp.tag
      }));
    } else {
      tagPatterns = [
        { pattern: /会议|座谈|研讨|论坛/g, tag: '会议' },
        { pattern: /项目|开工|竣工|投产/g, tag: '项目' },
        { pattern: /民生|就业|医疗|教育/g, tag: '民生' },
        { pattern: /文化|旅游|景区|公园/g, tag: '文旅' },
        { pattern: /经济|产业|企业|投资/g, tag: '经济' },
        { pattern: /安全|生产|消防|应急/g, tag: '安全' },
        { pattern: /党建|党史|党员/g, tag: '党建' },
        { pattern: /乡村|农村|振兴/g, tag: '乡村振兴' },
      ];
    }

    for (const { pattern, tag } of tagPatterns) {
      if (pattern.test(allText)) {
        tags.push(tag);
      }
    }

    return tags.length > 0 ? tags.slice(0, 3) : ['综合'];
  },

  _extractEntities(content) {
    const allText = content || '';
    const entities = [];

    const locationPattern = /([^\s]{2,6}(?:市|县|区|镇|乡|村|街|路|港|湾|岛|江|河|湖|山|海))/g;
    const locations = allText.match(locationPattern);
    if (locations) {
      new Set(locations.slice(0, 3)).forEach(name => {
        entities.push({ name: name, type: 'Place' });
      });
    }

    const orgPattern = /([^\s]{2,10}(?:公司|局|院|所|委|办|厅|部|委员会|集团|企业|学校|医院|银行|协会|联盟))/g;
    const orgs = allText.match(orgPattern);
    if (orgs) {
      new Set(orgs.slice(0, 2)).forEach(name => {
        entities.push({ name: name, type: 'Organization' });
      });
    }

    const personPattern = /(?:记者|通讯员|教授|博士|院士|主任|总监|所长|院长|校长|书记|市长|局长)\s*([^\s,，、]{2,4})/g;
    let match;
    const seenNames = new Set(entities.map(e => e.name));
    while ((match = personPattern.exec(allText)) !== null) {
      const name = match[1].trim();
      if (!seenNames.has(name) && !/^(报道|讯|摄|文|图)$/.test(name)) {
        entities.push({ name: name, type: 'Person' });
        seenNames.add(name);
      }
    }

    return entities.slice(0, 5);
  },

  _generateQA(content, entities) {
    const qa = [];

    const plainTitle = this._generateTitle(content);
    qa.push({
      q: this._truncate(plainTitle, 30) + '是怎么回事？',
      a: this._truncate(content, 100) || '目前暂无详细信息。'
    });

    if (entities.length > 0) {
      qa.push({
        q: (typeof entities[0] === 'object' ? entities[0].name : entities[0]) + '与什么相关？',
        a: this._truncate(content, 80) || '相关内容正在整理中。'
      });
    }

    qa.push({
      q: '这件事说明了什么？',
      a: '反映了当地在相关领域的积极举措。'
    });

    return qa;
  },

  _extractAuthors(content) {
    const allText = content || '';
    const authors = [];

    const roleStr = GEO_SHARED_CONSTANTS.AUTHOR_ROLES_REGEX.match(/\((.+)\)/)[1];
    const roles = roleStr.split('|');
    const rolePattern = roles.join('|');

    const authorPattern = new RegExp(`(?:${rolePattern})\\s*([^\\s,，、]{2,4})`, 'g');
    let match;
    while ((match = authorPattern.exec(allText)) !== null) {
      const fullMatch = match[0];
      const name = match[1].trim();
      const roleMatch = fullMatch.match(new RegExp(`(${rolePattern})`));
      const role = roleMatch ? roleMatch[1] : '记者';
      if (name && !/^(报道|讯|摄|文|图)$/.test(name)) {
        if (!authors.some(a => a.name === name)) {
          authors.push({ role: role, name: name });
        }
      }
    }

    return authors;
  }
};
