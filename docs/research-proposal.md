们搜索的是 Organization Strategy }\pi} \]

而不是搜索一个固定 Agent Graph，也不是搜索一棵 Organization Rule Tree。

\[ \boxed{\text{Tree-based Search 只是寻找 }\pi^\star\text{ 的搜索算法}} \]

最终 test-time 真正运行的是搜索得到的：

\[ \pi^\star, \]

它面对不同任务，动态做 `继续 / 复用 / 派生 / 连接 / 失活 / 停止`，因此长出不同的 task-specific MAS。

同时：

\[ \boxed{ \text{MIA 不评价 Agent 好不好，也不给边打数值分； 它约束策略搜索方向，并决定下一次最值得做哪个组织实验。} } \]

下面我按真正可以开始实现的程度完整写。

---

# 一、整个系统的四个核心对象

我们需要维护四个完全不同的对象：

\[ \boxed{ \mathcal A^P,\quad G_{x,t},\quad \pi,\quad \mathcal T_{\text{search}} } \]

它们分别是：

|对象|含义|生命周期|
|---|---|---|
|\(\mathcal A^P\)|Persistent Agent Population|跨任务|
|\(G_{x,t}\)|当前任务 Active Agent Graph|单任务动态变化|
|\(\pi\)|Organization Strategy|搜索对象|
|\(\mathcal T_{\rm search}\)|Strategy Search Tree|只存在于 Search 阶段|

最重要的关系是：

\[ \boxed{ \mathcal T_{\rm search} \rightarrow \pi^\star } \]

然后：

\[ \boxed{ (x,\pi^\star,\mathcal A^P) \rightarrow G_x } \]

也就是：

> Search Tree 找策略；Strategy 生成 Graph。

---

# 二、Persistent Agent Population

Agent 不再是一次性的 prompt persona。

每个 Agent：

\[ A_i= ( id_i, R_i, Q_i, T_i, M_i, C_i^{long}, H_i, S_i ). \]

其中：

\[ R_i \]

是开放式 capability description；

\[ Q_i \]

是长期/当前 responsibility；

\[ T_i \]

是该 Agent 自己拥有的 tools；

\[ M_i \]

是 private persistent memory；

\[ C_i^{long} \]

是长期 context；

\[ H_i \]

是历史任务、协作和 provenance；

\[ S_i \in \{ ACTIVE,DORMANT,RETIRED \}. \]

此外每道任务还有：

\[ C_{i,x}^{episode}. \]

因此完整 context 是：

\[ C_i = C_i^{long} \oplus C_{i,x}^{episode}. \]

任务结束后，episodic context 不直接永久保存，而是：

\[ C_{i,x}^{episode} \xrightarrow{\text{consolidate}} \Delta M_i. \]

然后 Agent：

\[ ACTIVE\rightarrow DORMANT. \]

---

# 三、Runtime Agent Graph

对于任务 \(x\)，维护：

\[ G_{x,t} = (V_{x,t},E_{x,t}). \]

V1 我甚至建议**不要再做连续的 \(W\)**。

Edge 先做成：

\[ e_{ij} = ( source, target, artifact/deficit, type ). \]

也就是说它表示：

> A\(i\) 当前为什么要给 A\(j\) 发送什么信息。

而不是：

\[ w_{ij}=0.73. \]

这样直接砍掉之前很大一部分不稳定性。

一个长期系统可能已经有：

\[ |\mathcal A^P|=50, \]

但某道任务：

\[ |V_{x,t}|=1. \]

另一道：

\[ |V_{x,t}|=4. \]

所以：

\[ \boxed{ \mathcal A^P\neq G_x. } \]

---

# 四、Agent 输出必须结构化

这是整个系统成立的基础。

每个 Agent 执行后，不应该只输出一大段自然语言。

建议输出：

\[ Z_i^t= ( Answer, Claims, Evidence, Artifacts, Deficits, Resolved, ToolEvents ). \]

例如：

```
candidate_answer: "..."

claims:
  - id: c1
    text: "..."
    evidence_refs: [e3]

artifacts:
  - id: e3
    type: symbolic_result
    content: "..."

open_deficits:
  - id: d2
    text: "The equality condition remains unsupported."
    owner: A0

resolved_deficits:
  - d1

tool_events:
  - tool: python
    status: success
```

这里最关键的是：

\[ \boxed{Deficit} \]

它仍然是完全开放语义的。

系统不预先规定：

- verifier deficit；
- programmer deficit；
- researcher deficit。

它就是当前 reasoning 自己暴露出来的：

> “还有什么 task-relevant information 没解决？”

---

# 五、MIA Meta-State 不需要任何 LLM 连续评分

对于每个 deficit：

\[ d \]

维护一个生命周期。

我建议直接用：

\[ \boxed{ MISSING \rightarrow LATENT \rightarrow ACTIVE \rightarrow DELIVERED \rightarrow RESOLVED } \]

具体解释：

### MISSING

当前 persistent population 中找不到可复用来源：

\[ source(d)=\varnothing. \]

---

### LATENT

已经找到相关 Agent：

\[ source(d)=A_i \]

但：

\[ A_i=DORMANT. \]

也就是说信息/能力可能已经存在，但没有激活。

---

### ACTIVE

相关 Agent 已经 active：

\[ A_i\in V(G_t), \]

但相关 artifact 尚未送达 deficit owner。

---

### DELIVERED

相关 artifact 已经到达：

\[ owner(d) \]

但：

\[ d \]

仍未 resolve。

这就是 conversion 未完成。

---

### RESOLVED

当前 deficit 已经解决。

---

所以 MIA 状态不是：

```
information_gain = 0.81
```

而是：

```
d2.status = LATENT
```

这种离散、可追踪的组织状态。

---

# 六、已有 Agent 是否和 deficit 相关怎么判断？

这里仍然不需要 LLM 给“信息价值分”。

Persistent Agent 提供：

```
capability_summary
tool_manifest
memory_summary
historical_task_tags
artifact_index
```

然后：

\[ Retrieve(d,\mathcal A^P) \]

可以使用：

- embedding similarity；
- tool compatibility；
- metadata filtering；
- memory semantic retrieval。

返回 Top-K。

必要时 LLM只做最后的：

\[ \boxed{\text{relevant / not relevant}} \]

分类。

不要求：

> “A7 对这个 deficit 的信息价值是 0.78。”

---

# 七、Organization Strategy \(\pi\)

这是我们真正要 Search 的对象。

定义：

\[ \boxed{ \pi:s_t\rightarrow a_t^{org} } \]

其中：

\[ s_t \]

包括：

\[ ( G_t, \mathcal A^P, D_t, AgentStates, ToolEvents, Budget, Progress ). \]

输出：

\[ a_t^{org} \in \mathcal U. \]

第一版 Organization Action Space 可以很小：

\[ \boxed{ \mathcal U= \{ CONTINUE, REACTIVATE, DERIVE, CONNECT, DISCONNECT, DORMANT, STOP \}. } \]

这些都是**纯组织操作**。

这里没有：

- VERIFY；
- PROGRAMMER；
- CRITIC；
- SOLVER；
- RESEARCHER。

---

# 八、动作的语义参数是开放的

例如：

\[ DERIVE(d) \]

只表示：

> 针对当前 deficit \(d\)，产生一个新的 autonomous Agent。

至于它最后是什么 Agent：

\[ A_{\rm new} = AgentFactory( d, parent, task, available\ tools ). \]

LLM 可以输出：

```
objective: ...
capability: ...
private_context: ...
tools:
  - ...
expected_output: ...
stop_condition: ...
```

所以 Search 没有预定义：

> “这里应该出现 verifier。”

系统只知道：

\[ \boxed{\text{需要新的认知资源}} \]

新认知资源具体长什么样，在 inference 时开放生成。

---

# 九、Strategy 第一版如何表示？

虽然最终 \(\pi\) 不要求是一棵树，但为了实现方便，我建议 V1 用一个**typed ordered-rule DSL**。

例如：

```
RULE 1
WHEN no_open_deficit
DO STOP

RULE 2
WHEN deficit.status == LATENT
DO REACTIVATE(deficit)

RULE 3
WHEN deficit.status == ACTIVE
    AND not delivered
DO CONNECT(source(deficit), owner(deficit))

RULE 4
WHEN deficit.status == MISSING
    AND local_progress_stalled
DO DERIVE(deficit)

RULE 5
DEFAULT
DO CONTINUE
```

这是：

\[ \pi \]

本身。

它可以是 rule list / policy program。

**Search Tree 才是真正的树。**

---

# 十、Search Tree

定义：

\[ \mathcal T_{\rm search} = (\mathcal V,\mathcal E). \]

每个节点：

\[ v_k = ( \pi_k, U_k, C_k, History_k, Trace_k ). \]

也就是说：

\[ \boxed{ v_k=\text{一套完整 Organization Strategy} } \]

Search Tree edge：

\[ v_i\rightarrow v_j \]

代表：

\[ \pi_j = Mutate(\pi_i,e_{ij}). \]

其中：

\[ e_{ij} \]

是一次局部 Strategy Mutation。

---

# 十一、Search Root

初始：

\[ \boxed{ \pi_0: Root\rightarrow CONTINUE/STOP } \]

也就是基本 Single Agent。

最保守可以直接：

```
Root solves.
If Root reports no unresolved deficit:
    STOP.
Otherwise:
    CONTINUE within local budget.
After budget:
    STOP.
```

不允许 subagent。

这就是 search tree root：

\[ v_0. \]

---

# 十二、第一次 Search：完整跑 Search Reservoir

假设：

\[ \mathcal D_s = \{x_1,\ldots,x_{50}\}. \]

完整运行：

\[ \pi_0 \]

一次。

每题保存：

\[ ( score, trace, checkpoints, deficits, agent outputs, tool events, cost ). \]

得到：

\[ \mathcal H_0. \]

这里最好保存可 fork 的 execution checkpoints：

```
task x17
  checkpoint 0: root start
  checkpoint 1: root answer
  checkpoint 2: deficit d2 created
```

后面策略 mutation 后，从真正发生分歧的 checkpoint 接着跑。

---

# 十三、Tree-based Search：Parent Selection

这一步和 MIA 分开。

Search Tree 中已有很多策略：

\[ \pi_0,\pi_1,\ldots,\pi_K. \]

哪一个值得继续 expand？

主要看真实：

\[ U(\pi_k). \]

可以使用 exploitation + exploration mixture：

\[ P(v_i) = (1-\lambda) \frac{ \exp(\hat U_i/\tau) }{ \sum_j\exp(\hat U_j/\tau) } + \lambda\frac1{|\mathcal V_{eligible}|}. \]

这样：

- 高 performance 策略更容易继续扩展；
- 仍保留少量低访问节点；
- 可以偶尔重新从 \(\pi_0\) 开始。

这里：

\[ \boxed{ \text{真实 Utility 选 Parent} } \]

而不是 MIA。

---

# 十四、选中 Parent 后，MIA 第一次介入

假设选中：

\[ \pi_p. \]

我们看它在 Search tasks 上的 traces。

统计主要 information-realization failure：

\[ B(\pi_p) = \{ MISSING, LATENT, UNROUTED, DELIVERED\_UNRESOLVED, OVERACTIVE \}. \]

例如：

```
MISSING               24%
LATENT                 41%
UNROUTED                8%
DELIVERED_UNRESOLVED   19%
OVERACTIVE              8%
```

这说明：

> 很多失败并不是缺新 Agent，而是已有 persistent Agent 没被复用。

---

# 十五、MIA 约束 Strategy Mutation 方向

普通 mutation space 可能很大：

\[ \mathcal E_{\rm all}. \]

MIA 根据当前 bottleneck，只开放相关的**组织维度**。

例如：

### MISSING

允许探索：

\[ CONTINUE \leftrightarrow DERIVE \]

以及它们的 guard / priority / fallback。

---

### LATENT

允许探索：

\[ REACTIVATE \]

相对：

\[ DERIVE/CONTINUE \]

的优先级。

---

### UNROUTED

允许：

\[ CONNECT,\ DISCONNECT, \]

或者 source/target selection policy。

---

### DELIVERED_UNRESOLVED

允许探索：

- 是否 CONTINUE；
- 是否进一步 DERIVE 新 deficit；
- 是否改变递归策略；
- 是否重新开放已有 Agent。

仍然不规定新 Agent 是 synthesizer 还是 verifier。

---

### RESOLVED / OVERACTIVE

允许：

\[ DORMANT,\ DISCONNECT,\ STOP. \]

因此：

\[ \boxed{ \mathcal E_{\rm MIA}(\pi_p) \subset \mathcal E_{\rm all}(\pi_p). } \]

这就是 MIA 第一个贡献：

\[ \boxed{\text{Search-space directional guidance}} \]

---

# 十六、具体的 Strategy Mutation Operators

Mutation 操作的是**策略逻辑**，不是 Agent 功能。

例如：

\[ \mathcal M= \{ ADD\_GUARD, REMOVE\_GUARD, CHANGE\_ACTION, CHANGE\_PRIORITY, ADD\_FALLBACK, REMOVE\_FALLBACK, CHANGE\_RECURSION, CHANGE\_STOP, CHANGE\_REUSE\_ORDER \}. \]

例如 Parent：

```
WHEN deficit == MISSING
DO DERIVE
```

Child：

```
WHEN deficit == MISSING
    AND local_progress_stalled
DO DERIVE

ELSE
DO CONTINUE
```

另一个 mutation：

```
WHEN deficit exists
DO DERIVE
```

变为：

```
WHEN deficit == LATENT
DO REACTIVATE

WHEN deficit == MISSING
DO DERIVE
```

没有定义任何具体 Agent 类型。

---

# 十七、这时候通常还有多个 Legal Mutations

假设 MIA filter 后还有：

\[ e_1,e_2,e_3,e_4. \]

以前可能四个都跑：

\[ 4\times50. \]

现在不这么做。

这里进入：

\[ \boxed{\text{MIA 第二次介入：Active Experiment Selection}} \]

---

# 十八、每次 Strategy Edit 都积累真实 outcome

对于：

\[ \pi_c = Mutate(\pi_p,e) \]

在同一道任务 \(x\) 上比较：

\[ u(\pi_c,x) - u(\pi_p,x). \]

对于 correctness benchmark：

\[ O_{e,x} \in \{+,\;0,\;-\} \]

分别是：

\[ +=0\rightarrow1 \]

correction；

\[ -=1\rightarrow0 \]

harm；

其余：

\[ 0. \]

例如历史上：

```
Mutation:
LATENT → prioritize REACTIVATE over DERIVE

12 observations:
  7 corrections
  4 neutral
  1 harm
```

---

# 十九、Posterior 完全来自真实执行

维护：

\[ \theta_e = (p_+,p_0,p_-). \]

先验：

\[ Dir(1,1,1). \]

得到 7/4/1 以后：

\[ \theta_e|\mathcal H \sim Dir(8,5,2). \]

没有：

- LLM confidence；
- LLM information score；
- pairwise Judge；
- \(g_{ij}\)。

全是：

\[ \boxed{\text{execution observations}} \]

---

# 二十、还需要 Trigger Rate

一个 mutation 不会影响所有任务。

例如：

```
LATENT → REACTIVATE first
```

可能只有 20% search tasks 遇到 LATENT。

从 parent traces 直接统计：

\[ q_e = P(\text{mutation branch triggered}). \]

那么一个 posterior sample 下的 expected distribution-level gain 可以粗略写：

\[ \mu_e = q_e(p_+-p_-). \]

这是程序算出来的。

---

# 二十一、MIA Acquisition 怎么算？

当前还有：

\[ e_1,\ldots,e_K. \]

从每个 posterior 中 Monte Carlo sample：

\[ \theta_e^{(m)} \sim p(\theta_e|\mathcal H). \]

算：

\[ \mu_e^{(m)}. \]

于是第 \(m\) 个“可能世界”里最佳 mutation：

\[ E^{\star(m)} = \arg\max_e\mu_e^{(m)}. \]

比如采样：

\[ M=1000. \]

发现：

```
e1 best: 510
e2 best: 430
e3 best: 50
e4 best: 10
```

得到：

\[ P(E^\star=e_1)=0.51 \]

等。

当前：

\[ H(E^\star) \]

就表示：

> 我们对“下一步到底哪种组织改法最好”有多不确定。

---

# 二十二、测试一个 mutation 会减少多少不确定性？

对 mutation：

\[ e \]

下一次 outcome：

\[ O_e\in\{+,0,-\}. \]

当前 Dirichlet 已经给：

\[ P(+|e), P(0|e), P(-|e). \]

分别假设未来看到 correction / neutral / harm，

更新 posterior，

重新算：

\[ H(E^\star|O_e). \]

于是：

\[ \boxed{ A_{\rm MIA}(e) = H(E^\star) - \mathbb E_{O_e} [ H(E^\star|O_e) ] } \]

也就是：

\[ \boxed{ I(O_e;E^\star|\mathcal H) } \]

选择：

\[ \boxed{ e^\star = \arg\max_e A_{\rm MIA}(e). } \]

这就是第二个 MIA 作用：

\[ \boxed{\text{Search-order guidance}} \]

仍然没有 LLM 数值评分。

---

# 二十三、Bootstrap 阶段怎么办？

刚开始：

\[ \mathcal H=\varnothing. \]

所有 mutation：

\[ Dir(1,1,1). \]

这时候信息增益大致一样。

因此 Search 初期做短暂 bootstrap：

- 对 MIA 合法 mutation family 各试少量 tasks；
- 或 round-robin；
- 或优先测试 trigger coverage 最大的 mutation。

例如：

\[ 3\sim5 \]

个 observation / mutation family。

之后 posterior 开始产生差异，再启用 MIA acquisition。

---

# 二十四、不是每个 Candidate 都跑 50 道题

对：

\[ e^\star \]

先从 parent traces 找：

\[ D(e^\star) = \{ x: \pi_c(x)\neq\pi_p(x) \}. \]

也就是实际会触发这个 mutation 的 tasks。

如果 50 道里只有 12 道相关：

\[ |D(e)|=12. \]

另外 38 道：

\[ u(\pi_c,x) = u(\pi_p,x) \]

直接继承。

---

# 二十五、Progressive Validation

先跑：

\[ B_0=4\sim5 \]

道 affected tasks。

例如：

```
4 tasks:
correction 0
neutral    1
harm       3
```

直接 reject。

不用再花钱。

如果：

```
correction 4
neutral    1
harm       0
```

继续扩大：

\[ 5\rightarrow10\rightarrow D(e). \]

只有特别 promising 的 Candidate Strategy 才做完整 confirmation。

这本质是：

\[ \boxed{\text{racing / successive resource allocation}} \]

---

# 二十六、Prefix Cache

这一点对成本特别重要。

如果 parent 与 child 在：

\[ t<t_{\rm mutation} \]

行为完全相同，

那么：

\[ Trace_{\rm parent}^{0:t} \]

直接缓存。

例如：

```
Root solve
  ↓
deficit d1 generated
  ↓
---------------- mutation point ----------------
  ↓
Parent: DERIVE
Child:  REACTIVATE
```

Root 不需要重新执行。

Child 从 checkpoint：

\[ C(x,t_{\rm mutation}) \]

继续即可。

---

# 二十七、Agent Cache

如果同一个 persistent Agent：

\[ A_i \]

在相同：

\[ local\ state+ incoming\ artifacts+ tool\ state \]

下已经执行过，

也可复用：

\[ CacheKey = ( agent\_id, state\_hash, incoming\_hash, tool\_snapshot ). \]

只要输入变化，就重新执行。

这样不会错误缓存。

---

# 二十八、Persistent Pool 也必须 Snapshot

这是实验公平性里很重要的一点。

Parent：

\[ \pi_p \]

和 Candidate：

\[ \pi_c \]

比较时必须从同一个：

\[ \mathcal A^P_{\rm snapshot} \]

开始。

Candidate 派生出的新 Agent：

\[ A_{\rm new} \]

先存在 candidate fork。

如果 Candidate 被 reject：

\[ A_{\rm new} \]

一起丢掉。

如果 Candidate 被 promotion，才考虑把经过 consolidation 的 Agent commit 到 canonical pool。

否则不同 strategy 会因为看到不同 Agent history 而无法公平比较。

---

# 二十九、Candidate Promotion

Small batch 只是负责：

\[ \boxed{\text{淘汰明显差的 Candidate}} \]

不能直接决定替换 incumbent。

真正 Candidate：

\[ \pi_c \]

成为新的 elite/incumbent 前：

1. 跑完整 affected set；
2. 复用 unaffected tasks；
3. 最好再有 held-out confirmation split。

计算：

\[ U(\pi_c) \]

和：

\[ U(\pi_p). \]

满足：

\[ U(\pi_c)>U(\pi_p) \]

且资源约束满足：

\[ C(\pi_c)\le B \]

才 promotion。

---

# 三十、Cost 作为 Constraint

不建议再做：

\[ Accuracy -\alpha Tokens -\beta Agents. \]

最好：

\[ \boxed{ \max_\pi U(\pi) } \]

subject to：

\[ E[Tokens(\pi)]\le B_{tok} \]\[ E[ActiveAgents(\pi)]\le B_{agent} \]\[ Depth(G_x)\le B_{depth}. \]

这样不需要调一堆人为 reward weights。

---

# 三十一、Search Tree 长什么样？

最后大概是：

```
                         π0
                    /          \
                  π1            π2
              76.3%           73.8%
              /   \               \
            π3     π4              π5
          79.1%   75.5%           77.0%
            |
            π6
          82.4%
           / \
         π7   π8
       81.9% 84.0%
                |
               π*
```

注意：

\[ \boxed{\text{每个 node 是完整 Organization Strategy}} \]

不是 Graph，

不是 Agent，

也不是一个 Rule。

Search Tree edge 才是：

\[ \boxed{\text{一次局部 Strategy Mutation}} \]

---

# 三十二、Search Stop

有三层停止条件。

硬预算：

\[ N_{\rm exec}\ge B_{\rm search} \]

或者：

\[ Tokens_{\rm search}\ge B_{\rm search}^{token}. \]

其次 elite 策略连续：

\[ L \]

轮没有显著 utility 提升。

最后 MIA：

\[ \max_e A_{\rm MIA}(e) < \epsilon_I. \]

也就是：

> 当前合法 Strategy Mutations 已经很难改变关于最佳搜索方向的判断。

因此可以写成：

\[ Stop = BudgetExhausted \lor [ UtilityStable \land InformationSaturated ]. \]

注意只能说：

> 当前 grammar + search distribution + budget 下搜索饱和。

不能声称全局最优。

---

# 三十三、Search 阶段伪代码

```
INPUT:
    search task reservoir D_search
    optional holdout D_val
    initial persistent pool A0 = {Root}
    strategy mutation grammar Ω
    search budget B

INITIALIZE:
    π0 = Single-Agent organization strategy
    T_search = {π0}

RUN π0 on D_search
CACHE:
    scores
    traces
    checkpoints
    MIA deficit states
    agent snapshots

H ← execution history

while budget remains:

    # 1. Parent selection
    πp ← SelectNode(T_search, actual task utility)

    # 2. Analyze real traces
    bottlenecks ← MIADecompose(πp.traces)

    # 3. Restrict mutation directions
    E ← GenerateLegalMutations(
            πp,
            bottlenecks,
            organization grammar Ω
        )

    # 4. Bootstrap / posterior update
    for e in E:
        posterior[e] ← UpdateFromRealHistory(H, e)

    # 5. Active experiment selection
    e* ← argmax_e EIG(e | H)

    # 6. Create one child strategy
    πc ← Mutate(πp, e*)

    # 7. Find only tasks actually affected
    D_aff ← AffectedTasks(πp, πc, cached traces)

    # 8. Fork same agent-pool snapshot
    pool_c ← Fork(πp.pool_snapshot)

    # 9. Small paired execution
    outcomes ← ExecuteSuffix(
        πc,
        selected small subset of D_aff,
        cached checkpoints
    )

    H ← H ∪ outcomes

    # 10. Early reject
    if candidate clearly harmful:
        AddSearchNode(πc, rejected)
        continue

    # 11. Progressive validation
    allocate more tasks from D_aff

    # 12. Full confirmation if promising
    if survives:
        Uc ← FullUtilityUsingCachedUnaffectedTasks(πc)

        AddSearchNode(πc, Uc)

        if Uc improves elite
           and resource constraints hold:
            Promote(πc)

    # 13. Stop?
    if utility converged
       and max EIG < threshold:
        break

OUTPUT:
    π*
    canonical persistent-agent snapshot
    search tree
    execution history
```

---

# 三十四、Test Inference 阶段

Search 完以后：

\[ \boxed{\pi^\star\text{ frozen}} \]

Search Tree 不再参与 inference。

新任务：

\[ x. \]

初始：

\[ G_{x,0} = \{Root\}. \]

然后进入组织循环。

---

# 三十五、Step 1：Root 先自己做

Root 获得：

\[ C_{Root,x}^{episode}. \]

执行：

\[ Root(x) \rightarrow Z_0. \]

如果：

\[ open\_deficits=\varnothing \]

那么很可能：

\[ \pi^\star(s_0)=STOP. \]

最终就是：

\[ \boxed{Single Agent} \]

不会为了确认“无需 MAS”先花一大堆候选成本。

---

# 三十六、Step 2：Runtime 更新 MIA Deficit State

假设 Root 产生：

\[ d_1: \]

> “当前结论依赖一个尚未验证的边界条件。”

Runtime 查 persistent population。

如果找到 dormant：

\[ A_7 \]

与这个 deficit 高度相关：

\[ status(d_1)=LATENT. \]

否则：

\[ status(d_1)=MISSING. \]

---

# 三十七、Step 3：运行 \(\pi^\star\)

例如：

\[ status(d_1)=LATENT. \]

策略可能输出：

\[ REACTIVATE(d_1). \]

Runtime 再解析具体 Agent：

\[ A^\star = Retrieve(d_1,\mathcal A^P). \]

于是：

\[ A_7: DORMANT \rightarrow ACTIVE. \]

加载：

\[ C_7^{long} + M_7 + C_{7,x}^{episode} + T_7. \]

---

# 三十八、如果没有 Agent 才 DERIVE

如果：

\[ status(d_1)=MISSING \]

且 Strategy 输出：

\[ DERIVE(d_1), \]

才调用 LLM AgentFactory。

LLM负责开放语义构造：

\[ A_{new}. \]

它只需要回答：

> 为了解决 \(d_1\)，当前最合理的 autonomous Agent 应该承担什么 objective、context 和 tools？

它不回答：

- information gain；
- expected score；
- \(g_{ij}\)；
- reliability 0.83。

---

# 三十九、Step 4：Agent 独立执行

新 Agent 拿到：

\[ C_i^{long} + C_{i,x}^{episode} + M_i + T_i. \]

自己 reasoning / tool use。

输出：

\[ Z_i. \]

其中包含：

- evidence；
- artifacts；
- resolved deficits；
- newly discovered deficits。

---

# 四十、Step 5：Graph 更新

如果某 Agent 持有：

\[ d \]

需要的 artifact，

但 owner 没收到：

\[ status(d)=ACTIVE/UNROUTED. \]

策略可以输出：

\[ CONNECT(d). \]

Runtime 根据：

\[ source(d),owner(d) \]

建立：

\[ A_i\rightarrow A_j. \]

传递的是：

\[ artifact/evidence \]

而不是整个 raw context。

---

# 四十一、Step 6：递归组织

收到新信息以后：

\[ s_{t+1} \]

更新。

再次：

\[ a_{t+1} = \pi^\star(s_{t+1}). \]

可能：

\[ CONTINUE \]

可能：

\[ DERIVE(d_2) \]

可能：

\[ REACTIVATE(d_2) \]

可能：

\[ DORMANT(A_i) \]

也可能：

\[ STOP. \]

所以 Graph：

\[ G_{x,0} \rightarrow G_{x,1} \rightarrow \cdots \rightarrow G_{x,T}. \]

是在 inference 过程中在线长出来的。

---

# 四十二、同一个策略产生不同结构

同一个：

\[ \pi^\star \]

对于简单任务：

\[ Root. \]

对于另一个任务：

\[ A_3\rightarrow Root. \]

再复杂一点：

\[ A_8\rightarrow A_4\rightarrow Root. \]

甚至：

\[ A_3,A_7 \rightarrow A_9 \rightarrow Root. \]

所以：

\[ \boxed{ G_x = Rollout( \pi^\star, x, \mathcal A^P ) } \]

才是最终 task-specific MAS。

---

# 四十三、Agent Dormancy

当：

- Agent local objective 完成；
- 它负责的 deficit 已 resolved；
- relevant artifact 已被下游吸收；
- 没有 active dependency；

则：

\[ \pi^\star \]

可以输出：

\[ DORMANT(A_i). \]

Agent 不删除。

只把 task-specific context consolidate：

\[ C_{i,x}^{episode} \rightarrow M_i. \]

然后：

\[ ACTIVE\rightarrow DORMANT. \]

以后新任务仍可以：

\[ DORMANT\rightarrow ACTIVE. \]

---

# 四十四、Standard Benchmark 和 Continual Benchmark

这两个实验必须分开。

### Standard Generalization

Search：

\[ D_{\rm search} \]

得到：

\[ \pi^\star. \]

Test 时：

\[ \pi^\star \]

冻结。

Persistent pool 也最好从同一个 fixed snapshot 开始。

每道 test task 不允许把新增 Agent 和记忆泄露给下一道 test task。

这是标准公平比较。

---

### Continual Organization

任务序列：

\[ x_1,x_2,\ldots,x_T. \]

允许：

\[ \mathcal A_1^P \rightarrow \mathcal A_2^P \rightarrow \cdots. \]

Agent memory、tools experience、new Agents 可以跨任务积累。

理想现象：

\[ DeriveRate(t)\downarrow \]

而：

\[ ReactivateRate(t)\uparrow. \]

以及平均：

\[ Cost/task \]

随经验下降，但 performance 保持或提高。

这才体现 persistent Agent 作为组织资产。

---

# 四十五、MIA Ablation 会非常干净

最终实验至少应该有这几个版本：

|Variant|MIA Search-space Guidance|MIA Acquisition|Strategy Evaluation|
|---|---|---|---|
|Random Tree Search|×|×|Real execution|
|LLM-guided Search|×|×|Real execution|
|MIA-Space|✓|×|Real execution|
|MIA-Acq|×|✓|Real execution|
|**MIA-Full**|✓|✓|Real execution|

重点不要只看最终 accuracy。

还要画：

\[ \boxed{ Best\ Validation\ Utility \quad vs\quad Search\ Executions } \]

以及：

\[ \boxed{ Best\ Validation\ Utility \quad vs\quad Search\ Tokens } \]

如果：

\[ \text{MIA-Full} \]

用更少 search executions 找到相同或更好的：

\[ \pi^\star, \]

那才真正证明：

\[ \boxed{\text{MIA improves organization search efficiency.}} \]

---

# 四十六、建议的实现顺序

如果现在真要开始改代码，我不会一次把全部东西上齐。

第一阶段先实现：

\[ \boxed{ Strategy DSL + Search Tree + Real Execution Evaluation } \]

先完全不加 MIA。

确保：

\[ \pi_0 \rightarrow \pi_1 \rightarrow \pi_2 \]

能够搜索、评估、缓存、回滚。

第二阶段加：

\[ \boxed{ Structured Deficit Lifecycle } \]

即：

\[ MISSING/LATENT/ACTIVE/DELIVERED/RESOLVED. \]

第三阶段加：

\[ \boxed{ MIA Search-space Filtering } \]

先验证 MIA-Space 有没有效果。

第四阶段才加：

\[ \boxed{ Dirichlet Posterior + Monte Carlo EIG } \]

做 MIA-Acq。

第五阶段再接：

\[ \boxed{ Persistent Agent Reuse } \]

和真正 continual experiments。

这样每一步出了问题都知道问题在哪，不会再次变成以前那种：

> \(h,\sigma,g,\lambda,\logdet,selector,candidate execution\) 全部绑在一起，不知道究竟是谁造成效果。

---

最终这套方法最精确的定义，我会写成：

\[ \boxed{ \begin{aligned} &\textbf{Search target:} &&\text{a reusable organization strategy }\pi.\\[2mm] &\textbf{Search algorithm:} &&\text{tree-based iterative strategy optimization}.\\[2mm] &\textbf{MIA role I:} &&\text{constrain mutation directions by information-realization state}.\\[2mm] &\textbf{MIA role II:} &&\text{actively select the most decision-informative structural experiment}.\\[2mm] &\textbf{Evaluator:} &&\text{actual downstream task execution}.\\[2mm] &\textbf{Inference:} &&\pi^\star\text{ dynamically organizes a persistent agent population}.\\[2mm] &\textbf{Agent semantics:} &&\text{open-ended and generated from runtime deficits}.\\ \end{aligned} } \]

这版我认为已经可以直接转成代码架构和 Method section 了，而且最关键的是：**MIA、LLM、真实 evaluator 三者职责彻底分开了。**