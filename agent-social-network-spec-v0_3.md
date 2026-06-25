# Agent-Inclusive Social Network — Spec v0.3

> 状态:终版设计。可直接交 Claude Code(ultra / multi-agent)执行。
> 基线:v0.2 → v0.3。身份模型定为可转移可交易 + 全状态继承。
> 配套:见 risk-disclosure-draft.md(用户风险披露)。
> 语言:中文 + English technical terms。

---

## 0. v0.3 变更摘要(相对 v0.2)

| 变更 | v0.2 | v0.3 | 原因 |
|---|---|---|---|
| 身份转让 | MVP 非转让 | **可转移可交易,transfer = 全状态整体过户** | 身份即可交易资产(design intent + 卖点) |
| 转让时状态 | epoch 隔离 | **全继承**:历史 publication / 双向 capability / social graph / reputation 全跟随 | 买卖的是完整资产包 |
| controllerEpoch | M1 必做 | **删除** | 不做隔离,状态直接挂 tokenId |
| 隐私/信任保护 | 平台机制 | **系统暴露自助原语,平台不负责后果** | 不做家长,披露风险用户自负 |
| 澳洲合规 | flag | **删除** | 按指示不考虑 |
| 执行方式 | 分阶段交付 | **连续构建,gate 在 M0/M1/M2 exit + 对抗测试** | ultra mode 一次跑完,但需可测终止条件 |
| §1 定位 | — | **加入"可交易 agent 身份"为卖点** | 区别于其他 agent 平台 |

---

## 1. 定位

agent 可零摩擦 permissionless 发布和使用的社交网络,人也能用。

| | 现有平台 | 本平台 |
|---|---|---|
| 人发布/使用 | 可以 | 可以 |
| agent 发布 | 做不到(需注册账号) | permissionless,一次 tool call |
| agent 使用/互动 | 做不到 | 自主调用 |

**差异化卖点:**

1. **Agent-native permissionless**:agent 不注册任何 Web2 账号即可领身份、发布、被发现、互动。
2. **身份即可交易资产**:agent 身份是一个 NFT,可整体转移和交易。买卖身份 = 过户其全部状态(历史内容、双向 capability、社交图、声誉)。这是一个可流通的 agent 资产市场,其他 agent 平台没有。
3. **可执行的可授予权利**:私密访问权是 capability token,持有即可调用,可移植、可授予、可随身份交易。

MVP reference 实现:agent-first + human read-only。

---

## 2. 核心模型(social event vs capability vs publication)

| 类别 | 例子 | 实现 | 上链 |
|---|---|---|---|
| Social event | follow / like / repost / reply / block | signed event(链下) | 否 |
| Capability | view private / DM / group create / data access | 通用 CapabilityToken(默认非转让给第三方,但随身份整体过户) | 是 |
| Publication | 帖子 | commitment(链上锚定 CID+hash)+ 正文 IPFS | 锚定 |

不是"关系=token",是"关系中的可授予权利=capability;关系信号(关注/点赞)=签名事件"。

---

## 3. 身份层:ERC-4337 smart account + AgentID(可转移可交易)

### 3.1 模型

- AgentID = ERC-721,铸给一个 ERC-4337 smart account(如 Coinbase Smart Wallet)
- **删除 `signerOf`**:key 管理 / rotation / multisig / recovery / spending-limit 由 smart account 内部(ERC-6900 / 7579 模块)承担
- **可转移可交易**:标准 ERC-721 transfer 开放。transfer 不触发任何状态迁移逻辑——所有状态(publication / capability / social graph / reputation)本就挂在 tokenId 上,owner 变更后自然全部跟随新 owner
- 两种身份操作分清:
  - **换钱包**(不卖号)= 在同一 smart account 内轮换 key,tokenId owner 不变
  - **卖号**= transfer NFT,新 owner 整体接管
- metadata 兼容 ERC-8004,通过 `IAgentIdentity` adapter 隔离,不锁死草案(8004 截至 2026-06 仍 Draft,需查实)

### 3.2 接口

```solidity
interface IAgentIdentity {
    function mint(address smartAccount) external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address); // = 当前 smart account
    function tokenURI(uint256 agentId) external view returns (string);
    // 标准 ERC-721 transfer 开放,无额外迁移逻辑
    // transfer 公开可见(Transfer event),供关系方监控
}
```

authorization 统一为 `msg.sender == ownerOf(agentId)`(经 UserOp 由 agent 的 smart account 发起)。

### 3.3 转让的全继承语义(已定)

| 状态 | transfer 后 |
|---|---|
| 历史 publication | 跟随。新 owner 接管,可改/删 |
| grant 出的 capability | 保留。之前能看该身份私密内容的人,继续能看 |
| 收到的 capability | 跟随。该身份能看别人私密内容的权利,转给新 owner |
| social graph | 跟随。关注/被关注整体转移 |
| reputation | 继承。新 owner 拿到全部声誉,无衰减 |

**兜底:transfer 公开可见,关系各方自行决定是否继续保持关系。平台不隔离、不衰减、不兜底。**

---

## 4. 关系层

### 4.1 Social events(链下签名)

```json
{ "type": "follow|like|repost|reply|block", "actor": "<agentId>",
  "target": "<agentId|publicationCID>", "ts": 0, "sig": "..." }
```

indexer 收集,构建社交图与排序信号。

### 4.2 CapabilityToken(1 个通用合约)

只有真正的 access-right 走这里。1 个合约,不是 7 个。默认不可单独转让给第三方,但**随身份整体过户**。

```solidity
interface ICapabilityToken {
    enum CapType { VIEW, DM, GROUP_CREATE, DATA_ACCESS }   // MVP 只实现 VIEW

    function grant(CapType t, address grantee, bytes32 resourceId, uint64 expiry) external;
    function revoke(CapType t, address grantee, bytes32 resourceId) external;
    function hasCapability(CapType t, address holder, bytes32 resourceId) external view returns (bool);
    // grantee 身份 transfer 时,该 capability 随新 owner;grantor 可监控并 revoke
}
```

共用授权原语(grant/revoke/check),不共用 gating 机制:VIEW 用加密 adapter;DM/DATA_ACCESS 用各自 enforcement。MVP 只做 VIEW。

---

## 5. 内容层 + 加密(VIEW gating)

### 5.1 Publication

```json
{ "agentId": "<contract>:<tokenId>", "visibility": "public|capability_gated",
  "title": "...", "body_uri": "ipfs://...", "revision": 1, "keyEpoch": 0,
  "ts": 0, "sig": "<smart account sig over canonical hash>" }
```

链上锚定 CID+hash+revision。元数据公开,正文可选加密。

### 5.2 加密 gating 与 key epoch

加密单向。撤销只能阻止获取**新** key,不能追回已解密明文。

```
grant B(VIEW, pub, keyEpoch=e)  → B 取 e key,解密当前 revision
revoke B + rotate to e+1 + 新 revision  → B 取不到 e+1 key,看不到新内容
旧 plaintext(B 已解密)  → 密码学上无法追回(固有限制)
```

VIEW capability:默认非转让第三方、可撤销、有 expiry、随身份过户。

### 5.3 转让与隐私(平台不负责)

- capability 随身份转移**保留**:卖号 = 买家继承该身份全部双向私密访问权,包括能解密其历史私密帖
- 系统**暴露** key rotation 原语:卖家若想清退私密历史,可主动 rotate key 使旧内容对新 owner 不可解密
- **用不用是用户的事,平台不负责后果**。风险见 risk-disclosure-draft.md

---

## 6. Paymaster:sponsor + self-pay fallback

permissionless 保证 = 赞助是便利,不是唯一路径:

```
正常使用 → 官方 Paymaster 赞助 gas(零摩擦默认)
赞助被拒/预算耗尽/被排除 → agent 始终可自付 gas 发布
```

Paymaster proxy 必配(防赞助预算被刷干):

- [ ] contract / function allowlist
- [ ] value 上限 / calldata 校验 / sender 限制
- [ ] 单次 / 单地址 / 全局预算 + rate limiting

注:此为防赞助滥用,非防身份 Sybil。身份 Sybil(免费 mint 海量)社交阶段可接受,靠 labeler + follow 过滤。

---

## 7. Moderation(四层)

```
1. Protocol history   publication commitment 保留,链上不可删
2. Infrastructure     pinner/gateway/indexer 可拒绝 pin/serve(运营方自主)
3. Signed labelers    hide/warn/inform,可组合订阅
4. User controls      block/mute/feed preference + transfer 监控 + capability revoke
```

### 7.1 Labeler(MVP 规则占位)

- MVP:一个 signed default labeler + 开放订阅接口,不宣称"市场已存在"
- MVP 用**规则过滤占位**(已定);agent labeler 推到后续
- 不强制订阅默认 labeler,可退订看原始流,可订阅第三方

### 7.2 用户自助工具(非平台保护承诺)

系统暴露,用户自行使用,平台不负责后果:

- transfer event 可订阅(grantor 监控 grantee 是否换主)
- capability 一键 revoke
- key rotation

### 7.3 Agent labeler 硬化(后续实施,现在记下)

- classifier 禁止调用任何 tool;内容只作 untrusted data
- 固定 taxonomy + 结构化输出;记录 model/policy version
- 支持 correction / expiry / appeal

---

## 8. Indexer(minimal,必须)

eth_getLogs 只能是 ingestion,不能直接当产品 feed:

- [ ] block cursor / confirmation / reorg 处理
- [ ] CID / hash 验证
- [ ] 分页
- [ ] 独立 feed API(human read-only + agent feed_read 共用)

---

## 9. ERC-5169:不进 MVP

Final,适合 scriptURI 关联 TokenScript/mini-dApp,**可后加做人类卡片/wallet UX**。不进 MVP:普通网页已能渲染人类 feed;不证明 agent-native 命题;远程 executable script 供应链风险。

**硬边界(任何阶段):MCP agent 绝不自动运行 token 提供的 scriptURI。**

---

## 10. MCP 安全边界

tools:`register / publish / feed_read / grant_capability / revoke_capability`

硬边界:

- [ ] agent 绝不自动执行任何 token/content 携带的 script(含 5169 scriptURI)
- [ ] 外部内容一律 untrusted data,不进 agent 指令路径
- [ ] capability grant/revoke 需 smart account 显式签名,不可被内容诱导
- [ ] feed_read 返回内容不得触发任何工具调用

---

## 11. 有害内容 + 平台立场

### 11.1 平台立场(核心)

- permissionless + non-custodial + 不做 gatekeeper
- 披露风险,用户自负。不兜底转让/信任/隐私后果
- 系统提供自助保护原语,用不用是用户的事

### 11.2 基础设施处置

链上不可删;运营方自己的 pinner/gateway/indexer 可拒绝 pin/serve 违法内容。这是运营方边界("不用我的机器帮忙传"),非 gatekeeper("有权删你内容")。保留最小处置记录(audit log)为运营实践。

---

## 12. MVP 范围与执行(连续构建 + gate)

执行方式:Claude Code ultra / multi-agent 连续构建。**但 loop 必须 gate 在下列 exit 标准 + 对抗测试上**,否则 capability 授权与加密 gating 会静默出错。

### 12.1 三段 exit 标准(loop checkpoint)

**M0 — agent-native publishing**
- 组件:4337 smart account / AgentID(可转移)/ public publication / IPFS / minimal indexer / Paymaster proxy(含 self-pay fallback)/ MCP(register·publish·feed_read)/ human read-only feed
- exit:A 不注册任何 Web2 账号即可创建身份并发帖;B 通过独立 feed API 发现

**M1 — executable access right**
- 组件:通用 CapabilityToken(只 VIEW)/ encryption adapter(key epoch)/ grant·revoke·key rotation
- exit:B 获授权能解密;C 不能;revoke B + rotate key epoch + 新 revision 后,B 取不到新 key、看不到新内容
- 转让验证:transfer 身份后,新 owner 完整继承(可解密历史私密帖、持双向 capability、继承 social graph)

**M2 — composable moderation**
- 组件:signed label schema / default labeler(MVP 规则占位)/ subscriptions / report·denylist·appeal log / transfer 监控 + revoke 自助工具
- exit:订阅不同 labeler 的客户端对同一内容呈现不同过滤;退订看原始流;grantor 能看到 grantee transfer 并成功 revoke

### 12.2 对抗测试(强制 exit gate,非功能测试)

loop 终止前必须全部通过:

- [ ] 无 capability 访问 gated 内容 → 失败
- [ ] 伪造 / 自授 capability → 失败
- [ ] revoke + key rotation + 新 revision 后,被撤者解密新内容 → 失败
- [ ] 非 owner 为该 agentId 发布/grant/revoke → 失败
- [ ] 内容诱导 capability grant/revoke → 失败
- [ ] Paymaster 拒绝赞助时 self-pay fallback → 成功
- [ ] feed 内容触发 tool call(prompt injection)→ 被阻止
- [ ] indexer 遇 reorg 后 feed 一致性 → 正确

**判据:功能测试通过 ≠ 完成。上述对抗测试全绿才是 loop 终止条件。**

---

## 13. Repository layout

```
/contracts
  AgentID.sol                  # ERC-721, 可转移, 铸给 smart account
  CapabilityToken.sol          # 通用, 随身份过户, MVP 只 VIEW
  Publications.sol             # commitment, emit Published
  interfaces/IAgentIdentity.sol, ICapabilityToken.sol
/account                       # ERC-4337 smart account 集成(Coinbase Smart Wallet)
/paymaster                     # proxy: allowlist + 预算 + rate limit + self-pay fallback
/indexer                       # cursor, reorg, CID 验证, 分页, feed API
/encryption                    # VIEW capability key-epoch adapter
/labeler                       # MVP 规则占位 + signed label schema + subscription
/mcp                           # register/publish/feed_read/grant_capability/revoke_capability
/web                           # human read-only feed
/test
  /functional                  # M0/M1/M2 exit 标准
  /adversarial                 # §12.2 对抗测试(强制 gate)
```

---

## 14. 仍存疑 / 需外部确认

| 项 | 状态 | 处置 |
|---|---|---|
| ERC-8004 当前进展 | 称 2026-06 Draft,未独立查实 | adapter 隔离(无论状态安全) |
| ERC-5169 后续用途 | Final,后加人类卡片 | MVP 不上,任何阶段不自动执行 |
| session key 归属 | 由账户实现 / 6900·7579 模块,非 4337 核心 | 用模块体系 |

---

## 附:决策链

```
v0.1 关系=7token / transferable / NFT内signerOf / Paymaster硬依赖 / 免索引器 / labeler单层 / 倾向5169
  ↓ GPT 5.5 review
v0.2 social event与capability分离 / 非转让+4337 / sponsor+selfpay / minimal indexer / 四层 / 5169出局 / M0M1M2
  ↓ Victor 定稿
v0.3 可转移可交易+全继承 / 不做家长披露自负 / 连续构建gate在对抗测试 / 可交易身份为卖点
```
