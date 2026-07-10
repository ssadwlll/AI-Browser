小红书 PC Web 端行为上报接口逆向分析报告
一、行为上报接口清单
1. 核心行为采集接口（Protobuf 编码）
| 属性 | 值 | |------|-----| | URL |  | | 方法 | POST | | 请求体格式 | Protobuf 二进制（Base64 传输） | | 触发频率 | 极高（页面加载后持续高频上报，间隔 50-500ms） | | Content-Type | application/x-protobuf | | 响应格式 | {"code":0,"msg":"Success","success":true} |

Protobuf 请求体结构（75 字节）：

Message {
  field 1: bytes (55 bytes) = 嵌套 EventMeta {
    field 1: varint = 5              // event_type（事件类型码）
    field 2: string = "discovery-undefined"  // page_context（页面上下文/来源）
    field 3: string = "0.0.0"        // version（埋点版本）
    field 7: string = "xhs-pc-web"   // app_id（应用标识）
    field 8: string = "6.31.3"       // sdk_version（SDK 版本号）
    field 14: varint                  // flags（状态标志位）
    field ?: varint = 递增计数器      // event_sequence（事件序列号，每次+1）
  }
  field 2: bytes (0 bytes) = 空     // 预留扩展字段
  field 3: bytes (109 bytes) = 嵌套 DeviceInfo {
    field 1: bytes (32 bytes) = MD5("c3b4a3c1474b840014e039cacc58fa9b")  // webId（32字节设备指纹哈希）
    // ... 其他设备/会话信息
  }
}
Protobuf 可读字符串提取：

discovery-undefined — 页面来源上下文
0.0.0 — 埋点 SDK 版本
xhs-pc-web — 应用 ID
6.31.3 — 前端构建版本号
c3b4a3 — webId 前缀（设备标识）
2. 笔记浏览指标上报接口
| 属性 | 值 | |------|-----| | URL |  | | 方法 | POST | | 请求体格式 | JSON | | Content-Type | application/json |

请求体结构：

{
  "note_id": "68d3506c0000000012032049",   // 笔记 ID
  "note_type": 2,                            // 笔记类型（2=图文/视频）
  "report_type": 2,                          // 上报类型（2=曝光, 3=互动）
  "stress_test": false,                      // 压测标志
  "trace": {
    "referer": "",  // 来源页面
    "source": "web_explore_feed"             // 流量来源
  }
}
report_type 枚举：

2 — 笔记曝光（进入视野）
3 — 笔记互动（点击/停留等）
响应：

{"code":0,"success":true,"msg":"成功","data":{"success":true}}
认证要求： 需要登录态（无登录返回 code:-101 "无登录信息"）

3. 浏览历史上报接口
| 属性 | 值 | |------|-----| | URL |  | | 方法 | POST | | 请求体格式 | JSON | | Content-Type | application/json |

请求体结构：

{
  "events": [{
    "event_id": "c3b4a3c1474b840014e039cacc58fa9b_68d3506c0000000012032049",
    "platform": "web",
    // ... 更多字段（被截断）
  }]
}
event_id 构成规则： {webId}_{note_id} — 设备ID + 笔记ID 拼接

响应：

{"success":true,"msg":"成功","data":{"received_count":1},"code":0}
4. APM 性能监控接口
| 属性 | 值 | |------|-----| | URL |  | | 方法 | POST | | 请求体格式 | JSON | | Content-Type | application/json |

请求体结构（片段）：

{
  "clientTime": 1783652210976,
  "context_sdkSessionId": "4cf789b4-bbba-4550-b36d-90d60bedee5d",
  "context_p...": "..."
}
二、上报触发条件
| 触发条件 | 上报接口 | 触发时机 | |----------|----------|----------| | 页面加载完成 | t2.xiaohongshu.com/api/v2/collect | DOMContentLoaded 后立即开始 | | 用户任何交互 | t2.xiaohongshu.com/api/v2/collect | 鼠标移动、点击、滚动、键盘输入等（高频节流 ~50ms） | | 页面生命周期 | t2.xiaohongshu.com/api/v2/collect | 页面可见性变化、前后台切换 | | 笔记卡片曝光 | edith.xiaohongshu.com/api/sns/web/v1/note/metrics_report | 笔记进入视口（IntersectionObserver） | | 笔记点击/停留 | edith.xiaohongshu.com/api/sns/web/v1/note/metrics_report | report_type=3 | | 浏览会话 | edith.xiaohongshu.com/api/sns/v1/history/report_web | 页面离开/会话结束时 | | 性能指标 | apm-fe.xiaohongshu.com/api/data | 页面加载性能指标收集后（定时批量） | | 设备安全 | as.xiaohongshu.com/api/sec/v1/ds | 页面初始化时（appId=xhs-pc-web） |

三、上报数据字段含义对照表
A. 设备指纹标识
| 字段名 | 来源 | 值示例 | 含义 | |--------|------|--------|------| | webId | Cookie | c3b4a3c1474b840014e039cacc58fa9b | 设备唯一标识（32位 hex/MD5），所有行为关联的核心 ID | | a1 | Cookie | 19ef1ff04eeqxhoa67yhlcnc072p8uizom2zryxwh50000227212 | 用户身份 ID（登录后绑定） | | websectiga | Cookie | f3d8eaee8a8c63016320d94a1bd00562d516a5417bc43a032a80cbg70f07d5c0 | Web 安全签名（防篡改令牌） | | sec_poison_id | Cookie | ea69bb9e-d026-4ede-b152-d9bdb4677190 | 安全投毒 ID（用于追踪异常行为） | | acw_tc | Cookie (HttpOnly) | 0ad59cfe... | 反爬虫 Token（阿里云 WAF） | | xsecappid | Cookie | xhs-pc-web | 应用标识 |

B. 设备指纹变量（JS 全局）
| 变量名 | 类型 | 值示例 | 含义 | |--------|------|--------|------| | _dsn | string | "a3" | DS 安全模块版本标识 | | _dsl | string | "1782982849185" | DS 模块最后加载时间戳 | | dssts | number | 2 | DS 安全状态（2=已加载完成） | | ds_pulling | - | - | DS 拉取中标志 | | getdss() | function | "1780544708861" | DS 签名时间戳 | | dsllt | localStorage | 1783651776071 | DS 最后加载时间 | | xhsFingerprintV3 | object | {getV18, getCurMiniUa, ...} | V3 指纹系统（含多个指纹采集方法） |

C. 硬件/环境指纹
| 属性 | 值 | 用途 | |------|-----|------| | navigator.platform | Win32 | 操作系统 | | navigator.hardwareConcurrency | 8 | CPU 核心数 | | navigator.deviceMemory | 8 | 设备内存（GB） | | screen.width × height | 1920 × 1080 | 屏幕分辨率 | | screen.colorDepth | 24 | 色深 | | devicePixelRatio | 1 | 设备像素比 | | navigator.language | zh-CN | 语言偏好 | | timezone | Asia/Shanghai | 时区 | | webBuild | 6.31.3 | 前端构建版本 |

D. localStorage 行为数据
| Key | 值 | 含义 | |-----|-----|------| | xhs_pc_web_browse_report_pending_v1 | [] | 待上报浏览事件队列 | | unloads_record | [[时间戳, 时长],...] | 页面停留时长记录 | | xhs_context_networkQuality | GOOD | 网络质量评估 | | xhs-pc-search-history-* | [...] 数组 | 按用户分组的搜索历史 | | xhs_sharding_key | 53 | 数据分片键 |

四、风控判定相关行为数据
4.1 设备指纹链（反自动化核心）
webId (cookie)  ←→  xhsFingerprintV3.getV18()
     ↕                    ↕
event_id = webId_noteId   _dsn + _dsl + dssts
     ↕                    ↕
collect protobuf        websectiga (签名验证)
风控逻辑：

webId 是所有行为数据的锚点，如果 webId 与设备指纹不匹配 → 标记异常
websectiga 是动态安全签名，每次请求携带，服务端验证签名一致性
_dsn/_dsl/dssts 构成 DS 安全状态链，dssts=2 表示安全模块加载完成
sec_poison_id 用于标记可疑设备，一旦标记后续所有请求进入风控审查
4.2 行为模式检测
| 检测维度 | 数据来源 | 风控判定 | |----------|----------|----------| | 鼠标轨迹 | collect 高频事件 | 轨迹是否自然（非直线、有抖动）、移动速度是否合理 | | 交互节奏 | collect 事件间隔 | 间隔是否均匀（自动化特征）vs 随机（人类特征） | | 页面停留 | unloads_record + metrics_report | 停留时间是否合理（秒开秒关=爬虫特征） | | 浏览深度 | metrics_report + history/report_web | 浏览笔记数量/速度是否异常 | | 会话一致性 | context_sdkSessionId | 同一会话内设备指纹是否变化 | | 网络质量 | xhs_context_networkQuality | proxy/VPN 环境通常网络质量波动大 |

4.3 关键风控信号汇总
| 信号 | 风控权重 | 说明 | |------|----------|------| | webId 与 xhsFingerprintV3 一致性 | ⭐⭐⭐⭐⭐ | 核心设备标识，不一致直接标记 | | websectiga 签名校验 | ⭐⭐⭐⭐⭐ | 每次请求校验，失败即拦截 | | dssts 状态 | ⭐⭐⭐⭐ | dssts≠2 表示安全模块未加载完毕，可疑 | | collect 事件频率/间隔 | ⭐⭐⭐⭐ | 固定频率=自动化，零频率=无头浏览器 | | sec_poison_id | ⭐⭐⭐ | 被标记过的设备持续监控 | | acw_tc 反爬 Token | ⭐⭐⭐ | 阿里云 WAF 层面的爬虫检测 | | a1 用户身份 | ⭐⭐⭐ | 未登录高频访问=可疑 | | performance.timing | ⭐⭐ | 页面加载速度过快（无渲染）= headless |

五、关键 JS 模块位置
| 模块 | 文件 | 关键函数 | |------|------|----------| | DS 安全 SDK | as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web (~60KB 混淆代码) | getdss(), _dsf, _dsn/_dsl 设置逻辑 | | 指纹 V3 | Webpack Chunk 内联 | xhsFingerprintV3.getV18(), getCurMiniUa(), r6() | | 采集上报 | Webpack Chunk 内联 | r6() 函数 (function(){report(e,a,r)}) | | API 封装 | Webpack Chunk 内联 | xhsApi.getNote(), xhsApi.search(), xhsApi.checkEnv() | | APM SDK | 独立 SDK | context_sdkSessionId 管理 |

六、复用建议
6.1 模拟正常用户行为需满足：
携带完整 Cookie 链：a1 + webId + websectiga + xsecappid + acw_tc
保持 webId 一致性：所有请求的 webId 必须来自同一设备注册
collect 事件需自然间隔：避免固定频率，加入 50-500ms 随机抖动
protobuf 编码正确：需逆向完整的 .proto 定义
DS 安全握手完成：先请求 ds?appId=xhs-pc-web 获取安全配置
6.2 关键限制：
metrics_report 需要登录态（code:-101 拦截未登录请求）
collect 接口 protobuf 结构中的计数器必须单调递增
websectiga 签名算法在混淆 JS 中，直接复用困难
七、数据引用
| Store ID | 内容 | |----------|------| | p29-p46 | 捕获的网络请求（含完整请求/响应体） | | p34 | Performance API 中的 collect 请求列表 | | p41 | DS 安全变量、localStorage、Cookie、Navigator 指纹 | | p45 | Protobuf 解码分析结果 |