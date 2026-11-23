# 湖工一体公开中转服务器

给湖工一体公开版用的独立中转服务器：一个普通 Node.js HTTP 服务，
零运行时依赖。GitHub Pages 上的公开版静态页（国内可直接打开）调它，
就能像个人版一样用全功能：教务课表/成绩/空教室、至评卓学高数作业
和签到、智慧树签到、查电费。

中转逻辑从个人版 App 服务器原样抽出（`src/relay.ts`，逻辑一字未改，
只把 zod schema 换成了普通 TS 类型、去掉了 Muse action 包装）；
接口文档见 `~/workspace/hu-gong-yi-ti/api-endpoints.md`（教务）、
`~/workspace/hu-gong-yi-ti/lazynut-api.md`（至评卓学）、
`~/workspace/hu-gong-yi-ti/zhihuishu-signin-api.md`（智慧树签到）、
`~/workspace/hu-gong-yi-ti/kongxianjiaoshi-api.md`（空教室）、
`~/workspace/tuoqiang/api-notes.md`（查电费）。

## 隐私保证

- 密码 / 密码密文只用一次：调一次上游接口，用完即丢。不存库、不记日志。
- 不存任何个人信息，不记访问日志。服务器日志只有 `方法 路径 状态码 耗时`，
  不含请求体、不含 IP。
- 智慧树 Polymas 会话（token + cookie）只存在本进程内存里，60 分钟或首个
  401 即丢，和个人版 App 服务器一样。
- 只做查询和学生自己的提交：查课表、查成绩、查空教室、拉作业、交自己的
  作业、签自己到的到。不做充值、缴费、合闸/拉闸等控制操作。
- 失败原样返回对方服务自己的文案（教务“登录失败”、至评卓学“用户不存在”、
  智慧树“滑动验证码校验失败”等），绝不编数据。

## 快速开始

```bash
npm install
npm run build
npm start          # 默认 0.0.0.0:3000，PORT 环境变量可改端口
```

要求 Node.js ≥ 20。`npm install` 只装构建用的 typescript + @types/node
（devDependencies），运行时零依赖。

```bash
curl http://localhost:3000/health
# {"ok":true,"service":"hu-gong-yi-ti-public-relay"}
```

## 接口

全部是 `POST` + JSON 请求体，返回 JSON。跨域已开：
`Access-Control-Allow-Origin: *`，GitHub Pages 静态页可直接调。
`GET /` 返回全部路由列表。

### 教务（强智 jw.hnit.edu.cn）

`pwd` 是手机端 AES-ECB 双层 Base64 加密后的密文（加密在手机上做，
明文不出手机），服务端原样转发、用完即丢。

| 接口 | 入参 | 说明 |
|---|---|---|
| `POST /api/jw/timetable` | `{userNo, pwd}` | 登录 + 拉全学期课表，返回解析后的课程、节次时间、学期名、当前周 |
| `POST /api/jw/grades` | `{userNo, pwd}` | 登录 + 调 `/student/termGPA`，返回 perInfo（含官方平均学分绩点 pjxfjd）+ 成绩列表 |
| `POST /api/jw/idle-classrooms` | `{userNo, pwd, date, nodeId, buildingId?, campusId?, jsmc?, xnxq?, jiaoxueloumc?, jslx?}` | 空闲教室列表。`date` 为 `YYYY-MM-DD`；`nodeId` 为开始+结束节次拼接（`"12"`=1-2节，`"910"`=9-10节） |
| `POST /api/jw/idle-classroom-options` | `{userNo, pwd, campusId?}` | 校区 / 教学楼 / 节次下拉选项 |

### 至评卓学（lazynut.net）

`school` 是学校名字符串（如 `"湖南工学院"`），只在学号/工号登录时传；
账号登录（用户名/邮箱/手机号）不传。密码每次登录用完即丢。

| 接口 | 入参 | 说明 |
|---|---|---|
| `POST /api/lazynut/assignments` | `{username, password, school?}` | 班级 + 每班作业列表 + 提交状态/得分 |
| `POST /api/lazynut/assignment-detail` | `{username, password, school?, assignmentId, classId}` | 题目（已展平子题、归一化题型选项）+ 草稿 + 最新提交 |
| `POST /api/lazynut/upload-image` | `{username, password, school?, imageBase64, filename}` | 传一张作答图（base64，单张限 10MB），返回 `{url, fileId}` |
| `POST /api/lazynut/delete-image` | `{username, password, school?, fileId}` | 删除已传的图片 |
| `POST /api/lazynut/save-draft` | `{username, password, school?, assignmentId, items, images, note, discardedUploadFileIds}` | 存草稿。`items` 是学生自己的答案，原样转发、不改不判 |
| `POST /api/lazynut/submit-assignment` | 同上 + `{isIncomplete}` | 交作业。服务端只校验 items 非空，答案原样转发 |
| `POST /api/lazynut/submission` | `{username, password, school?, submissionId}` | 提交详情 + 批改结果（未批改返回 null） |
| `POST /api/lazynut/signin-list` | `{username, password, school?}` | 待签到列表 + 待签角标 |
| `POST /api/lazynut/signin-detail` | `{username, password, school?, classId, activityId}` | 签到详情（位置点三选一归一化，默认范围 100 米） |
| `POST /api/lazynut/signin-records` | `{username, password, school?, classId, activityId}` | 自己的签到记录 |
| `POST /api/lazynut/signin-submit` | `{username, password, school?, classId, activityId, deviceId, lat, lng, qrContent, gesturePattern}` | 提交一次真实签到。按类型带：普通只带 deviceId；位置带 GPS；手势带 3x3 九宫格序号串（0-8，至少 4 点）；扫码带 qrContent。提交后重读记录确认再返回 |

### 智慧树（知到）签到

签到要先 `prepare` 登录换 token：手机端渲染智慧树官方 AbleCaptcha
滑块，学生自己滑，`validate` 一次性交给服务端登录。token + cookie
只存本进程内存（60 分钟或首个 401 即丢）。后续 list/detail/submit
只凭 `account` 找内存会话，不再要密码。

| 接口 | 入参 | 说明 |
|---|---|---|
| `POST /api/zhihuishu/captcha-resource` | `{url, method?, body?, contentType?}` | 验证码资源中转：只搬运白名单内的智慧树 AbleCaptcha 脚本、易盾 load.min.js/核心/API（c.dun.163.com）、滑块图片，原样返回（文本 UTF-8 / 二进制 base64）。15 秒超时、3 MB 上限。不解验证码、不替滑 |
| `POST /api/zhihuishu/prepare` | `{account, password, validate}` | 服务端登录智慧树（AES 加密体）→ CAS SSO → 换 Polymas token，建内存会话 |
| `POST /api/zhihuishu/signin-list` | `{account}` | 列进行中的签到（轮询三个 activityTask/list 候选接口合并去重，只留像签到的行） |
| `POST /api/zhihuishu/signin-detail` | `{account, signId, term?, courseId?, lessonId?}` | 签到详情（类型 1=扫码 2=手势 3=口令 4=位置 5=拍照、截止时间、位置范围默认 300 米） |
| `POST /api/zhihuishu/signin-records` | `{account, signId}` | 自己的签到记录 |
| `POST /api/zhihuishu/signin-qr-resolve` | `{account, sceneKey}` | 扫码后解析 sceneKey 得 signId |
| `POST /api/zhihuishu/signin-submit` | `{account, signId, signType, term, courseId, lessonId, lat, lng, address, gesture, passwordText}` | 提交一次真实签到。位置要 BD09 坐标（手机端 GPS 转）；手势是 1-based 点位串（至少 4 个不同点）；口令字段名 `signPassword` 是按官方命名推的，未验证，拒了会原样返回对方报错；拍照签到拒绝提交（格式没验证过，请去知到 App） |

### 查电费（拓强）

| 接口 | 入参 | 说明 |
|---|---|---|
| `POST /api/elec/balance` | `{code, name?, phone?}` | 扫码号/表号查余额。每次用全新 uuid 匿名登录 → 绑表（若需，按姓名+手机号一次）→ 列出表 → 查详情，返回“使用详情”卡里的当前剩余金额。未绑定的表如实返回 `needBind`，不编余额。只读查询，不做充值/控表 |

## 部署提示（给接手部署的人）

- 这是一个常驻进程服务（`node dist/server.js`），不是 serverless 函数。
  直接部署到 VPS / 容器 / 任何能跑 Node 的主机即可；`PORT` 环境变量
  指定端口，前面挂 Nginx/Caddy 做 HTTPS。
- **必须单实例**（或保证同一同学的智慧树 `prepare → signin-list/detail/submit`
  打到同一个实例）：智慧树会话存在进程内存里，多实例之间不共享，
  换实例会查不到登录态。教务、至评卓学、查电费的接口是无状态的，
  不受这个限制。
- Vercel 这类按调用计费的 serverless 平台不适合直接部署本服务：
  每次调用都可能是新实例，智慧树内存会话会丢；而且验证码中转和
  智慧树登录链在冷启动下会更慢。如坚持用 Vercel，需把会话改成
  外部存储（Redis/KV）后再拆成函数，工作量另计。
- 建议配 HTTPS 再给 GitHub Pages 用；同时建议在反代层加基础限流
  （按 IP 限速），防止验证码/登录接口被刷。

## 实测记录（2026-11-23，本机）

本地 `npm install` → `npm run build` → `npm start` 跑通；23 个接口
用假账号逐个实测，返回的全部是对方服务自己的错误，无编造数据：

- 教务 4 个：假学号 → 学校自己的 `登录失败：登录失败！`
- 至评卓学 11 个：假账号 → 至评卓学自己的 `用户不存在`
- 智慧树 `captcha-resource`：真实 `load.min.js` 取回（ok:true，内容为
  易盾 NECaptcha 原始 JS）；白名单外地址如实拒绝
- 智慧树 `prepare`：假 validate → 智慧树自己的 `滑动验证码校验失败`
  （说明 AES 加密体格式正确，服务端解密并校验了验证码）
- 智慧树其余 5 个：无会话时如实返回 `needsLogin: true`
- 查电费：格式正确但不存在的表号 → `needBind`；乱码 → 解析错误
- 校验：缺字段/非法 JSON/未知路由/错误方法分别返回 400/400/404/405；
  OPTIONS 预检返回 `Access-Control-Allow-Origin: *`；日志只含
  方法+路径+状态码+耗时，无请求体、无 IP
- 真账号成功路径（课表同步、成绩、签到提交）只能由同学在自己手机上
  绑一次账号后实测，密码只在他们手机上。
