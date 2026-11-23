// 湖工一体公开中转服务器 — HTTP 入口。
//
// 把 relay.ts 里的中转函数挂成普通 HTTP 接口，供 GitHub Pages 上的
// 公开版静态页（国内可直接打开）调用。无状态：每个请求用完即丢，
// 不存任何密码、不存个人信息、不记访问日志（只在启动时打一行，
// 出错时只记方法+路径+状态码，绝不记请求体）。
//
// 智慧树签到会话（Polymas token + cookie）只存在本进程内存里
// （60 分钟或首个 401 即丢），和个人版 App 服务器一样。部署时
// 请保持单实例，或保证同一同学的 prepare → list/detail/submit
// 打到同一个实例上；多实例无共享会话会让签到查不到登录态。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  relayJiaowuSync,
  relayGrades,
  relayIdleClassrooms,
  relayIdleClassroomOptions,
  relayLazynutAssignments,
  relayLazynutAssignmentDetail,
  relayLazynutUploadImage,
  relayLazynutDeleteImage,
  relayLazynutSave,
  relayLazynutSubmission,
  relayLazynutSolveQuestion,
  relayLazynutSignInList,
  relayLazynutSignInDetail,
  relayLazynutSignInRecords,
  relayLazynutSignInSubmit,
  relayZhihuishuCaptchaResource,
  relayZhihuishuPrepare,
  relayZhihuishuSignInList,
  relayZhihuishuSignInDetail,
  relayZhihuishuSignInRecords,
  relayZhihuishuQrResolve,
  relayZhihuishuSignInSubmit,
  relayElecBalance,
} from "./relay.js";

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 16 * 1024 * 1024; // 15 MB 图片 base64 + 余量

// ---- 临时收件箱：公开上传页收照片和长视频 ----
// 用户从另一台手机打开公开上传页，把照片/视频传上来，我再从
// 服务器取回。文件只存在本实例磁盘上（Railway 无持久卷，重新
// 部署会丢），取回后即删。UPLOAD_TOKEN 未设置时接口全部 404。
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? join(process.cwd(), "uploads");
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN ?? "";
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB 单文件上限

type Json = Record<string, unknown>;

class BadRequest extends Error {}

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function reqStr(body: Json, key: string, max = 2000): string {
  const v = body[key];
  if (typeof v !== "string" || v.trim() === "" || v.length > max) {
    throw new BadRequest(`缺少或非法的字段：${key}`);
  }
  return v;
}

function optStr(body: Json, key: string, max = 2000): string | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > max) throw new BadRequest(`非法的字段：${key}`);
  return v;
}

function reqNum(body: Json, key: string): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`缺少或非法的字段：${key}`);
  return v;
}

function optNum(body: Json, key: string): number | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`非法的字段：${key}`);
  return v;
}

function optNullStr(body: Json, key: string, max = 2000): string | null {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || v.length > max) throw new BadRequest(`非法的字段：${key}`);
  return v;
}

function reqArr(body: Json, key: string): unknown[] {
  const v = body[key];
  if (!Array.isArray(v)) throw new BadRequest(`缺少或非法的字段：${key}`);
  return v;
}

function optArr(body: Json, key: string): unknown[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new BadRequest(`非法的字段：${key}`);
  return v;
}

function reqBool(body: Json, key: string): boolean {
  const v = body[key];
  if (typeof v !== "boolean") throw new BadRequest(`缺少或非法的字段：${key}`);
  return v;
}

// 懒加载式校验：至评卓学账号（用户名+密码，可选学校名）。
function lzCreds(body: Json): { username: string; password: string; school: string | undefined } {
  return {
    username: reqStr(body, "username", 80),
    password: reqStr(body, "password", 200),
    school: optStr(body, "school", 60),
  };
}

type Handler = (body: Json) => Promise<unknown>;

const ROUTES: Record<string, Handler> = {
  // ---- 教务（强智）----
  "/api/jw/timetable": async (b) =>
    relayJiaowuSync(reqStr(b, "userNo", 40), reqStr(b, "pwd", 512)),
  "/api/jw/grades": async (b) =>
    relayGrades(reqStr(b, "userNo", 40), reqStr(b, "pwd", 512)),
  "/api/jw/idle-classrooms": async (b) =>
    relayIdleClassrooms(reqStr(b, "userNo", 40), reqStr(b, "pwd", 512), {
      date: reqStr(b, "date", 10),
      nodeId: reqStr(b, "nodeId", 8),
      buildingId: optStr(b, "buildingId", 80),
      campusId: optStr(b, "campusId", 80),
      jsmc: optStr(b, "jsmc", 80),
      xnxq: optStr(b, "xnxq", 80),
      jiaoxueloumc: optStr(b, "jiaoxueloumc", 80),
      jslx: optStr(b, "jslx", 80),
    }),
  "/api/jw/idle-classroom-options": async (b) =>
    relayIdleClassroomOptions(reqStr(b, "userNo", 40), reqStr(b, "pwd", 512), optStr(b, "campusId", 80)),

  // ---- 至评卓学（高数作业 + 签到）----
  "/api/lazynut/assignments": async (b) => {
    const c = lzCreds(b);
    return relayLazynutAssignments(c.username, c.password, c.school);
  },
  "/api/lazynut/assignment-detail": async (b) => {
    const c = lzCreds(b);
    return relayLazynutAssignmentDetail(c.username, c.password, c.school, reqStr(b, "assignmentId", 80), reqStr(b, "classId", 80));
  },
  "/api/lazynut/upload-image": async (b) => {
    const c = lzCreds(b);
    return relayLazynutUploadImage(c.username, c.password, c.school, reqStr(b, "imageBase64", 14_000_000), reqStr(b, "filename", 120));
  },
  "/api/lazynut/delete-image": async (b) => {
    const c = lzCreds(b);
    return relayLazynutDeleteImage(c.username, c.password, c.school, reqStr(b, "fileId", 80));
  },
  "/api/lazynut/save-draft": async (b) => {
    const c = lzCreds(b);
    return relayLazynutSave(c.username, c.password, c.school, {
      assignmentId: reqStr(b, "assignmentId", 80),
      items: reqArr(b, "items") as never,
      images: optArr(b, "images") as string[],
      note: optStr(b, "note", 2000) ?? "",
      discardedUploadFileIds: optArr(b, "discardedUploadFileIds") as (string | number)[],
    }, false);
  },
  "/api/lazynut/submit-assignment": async (b) => {
    const c = lzCreds(b);
    return relayLazynutSave(c.username, c.password, c.school, {
      assignmentId: reqStr(b, "assignmentId", 80),
      items: reqArr(b, "items") as never,
      images: optArr(b, "images") as string[],
      note: optStr(b, "note", 2000) ?? "",
      discardedUploadFileIds: optArr(b, "discardedUploadFileIds") as (string | number)[],
      isIncomplete: reqBool(b, "isIncomplete"),
    }, true);
  },
  "/api/lazynut/submission": async (b) => {
    const c = lzCreds(b);
    return relayLazynutSubmission(c.username, c.password, c.school, reqStr(b, "submissionId", 80));
  },
  "/api/lazynut/solve-question": async (b) =>
    relayLazynutSolveQuestion({
      questionId: optStr(b, "questionId", 120) ?? "",
      question: reqStr(b, "question", 4000),
      options: (optArr(b, "options") as unknown[]).filter((o): o is string => typeof o === "string").slice(0, 12),
      type: optStr(b, "type", 40) ?? "",
    }),
  "/api/lazynut/signin-list": async (b) => {
    const c = lzCreds(b);
    return relayLazynutSignInList(c.username, c.password, c.school);
  },
  "/api/lazynut/signin-detail": async (b) => {
    const c = lzCreds(b);
    return relayLazynutSignInDetail(c.username, c.password, c.school, reqStr(b, "classId", 80), reqStr(b, "activityId", 80));
  },
  "/api/lazynut/signin-records": async (b) => {
    const c = lzCreds(b);
    return relayLazynutSignInRecords(c.username, c.password, c.school, reqStr(b, "classId", 80), reqStr(b, "activityId", 80));
  },
  "/api/lazynut/signin-submit": async (b) => {
    const c = lzCreds(b);
    return relayLazynutSignInSubmit(c.username, c.password, c.school, {
      classId: reqStr(b, "classId", 80),
      activityId: reqStr(b, "activityId", 80),
      deviceId: reqStr(b, "deviceId", 80),
      lat: optNum(b, "lat"),
      lng: optNum(b, "lng"),
      qrContent: optNullStr(b, "qrContent", 2000),
      gesturePattern: optNullStr(b, "gesturePattern", 9),
    });
  },

  // ---- 智慧树（知到）签到 ----
  "/api/zhihuishu/captcha-resource": async (b) =>
    relayZhihuishuCaptchaResource(
      reqStr(b, "url", 4000),
      (optStr(b, "method", 10) as "GET" | "POST" | undefined) ?? "GET",
      optNullStr(b, "body", 200000),
      optNullStr(b, "contentType", 120),
    ),
  "/api/zhihuishu/prepare": async (b) =>
    relayZhihuishuPrepare(reqStr(b, "account", 80), reqStr(b, "password", 200), reqStr(b, "validate", 2000)),
  "/api/zhihuishu/signin-list": async (b) =>
    relayZhihuishuSignInList(reqStr(b, "account", 80)),
  "/api/zhihuishu/signin-detail": async (b) =>
    relayZhihuishuSignInDetail(
      reqStr(b, "account", 80),
      reqStr(b, "signId", 120),
      optStr(b, "term", 40),
      optStr(b, "courseId", 80),
      optStr(b, "lessonId", 80),
    ),
  "/api/zhihuishu/signin-records": async (b) =>
    relayZhihuishuSignInRecords(reqStr(b, "account", 80), reqStr(b, "signId", 120)),
  "/api/zhihuishu/signin-qr-resolve": async (b) =>
    relayZhihuishuQrResolve(reqStr(b, "account", 80), reqStr(b, "sceneKey", 2000)),
  "/api/zhihuishu/signin-submit": async (b) => {
    const signType = reqStr(b, "signType", 20);
    if (!["LOCATION", "GESTURE", "QRCODE", "PASSWORD", "PHOTO"].includes(signType)) {
      throw new BadRequest("非法的字段：signType");
    }
    return relayZhihuishuSignInSubmit(reqStr(b, "account", 80), {
      signId: reqStr(b, "signId", 120),
      signType,
      term: reqStr(b, "term", 40),
      courseId: reqStr(b, "courseId", 80),
      lessonId: reqStr(b, "lessonId", 80),
      lat: optNum(b, "lat"),
      lng: optNum(b, "lng"),
      address: optNullStr(b, "address", 300),
      gesture: optNullStr(b, "gesture", 9),
      passwordText: optNullStr(b, "passwordText", 120),
    });
  },

  // ---- 拓强查电费 ----
  "/api/elec/balance": async (b) =>
    relayElecBalance(reqStr(b, "code", 2000), optStr(b, "name", 40) ?? "", optStr(b, "phone", 20) ?? ""),
};

const ROUTE_LIST = Object.keys(ROUTES).sort();

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BadRequest("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ---- 临时收件箱接口：/api/up/<token>/upload|list|file/<name> ----
function uploadCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function uploadTokenOk(url: URL): boolean {
  if (!UPLOAD_TOKEN) return false;
  const parts = url.pathname.split("/").filter(Boolean); // ["api","up",token,...]
  return parts.length >= 3 && parts[0] === "api" && parts[1] === "up" && parts[2] === UPLOAD_TOKEN;
}

function uploadFileName(original: string): string {
  const safe = basename(original).replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(-120) || "file";
  const stamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
  return `${stamp}-${randomBytes(4).toString("hex")}-${safe}`;
}

function uploadContentType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "mp4" || ext === "mov" || ext === "m4v") return "video/mp4";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "mp3") return "audio/mpeg";
  return "application/octet-stream";
}

async function handleUploadApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const headers = uploadCorsHeaders();
  const send = (status: number, obj: unknown) => {
    res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  if (!uploadTokenOk(url)) {
    send(404, { ok: false, message: "没有这个接口" });
    return;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const action = parts[3] ?? "";

  if (req.method === "GET" && action === "list") {
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const files = readdirSync(UPLOAD_DIR)
      .map((name) => {
        const st = statSync(join(UPLOAD_DIR, name));
        return { name, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    send(200, { ok: true, files });
    return;
  }

  if (req.method === "GET" && action === "file") {
    let name = "";
    try {
      name = basename(decodeURIComponent(parts[4] ?? ""));
    } catch {
      name = "";
    }
    const file = join(UPLOAD_DIR, name);
    if (!name || !existsSync(file) || !statSync(file).isFile()) {
      send(404, { ok: false, message: "文件不存在" });
      return;
    }
    const st = statSync(file);
    res.writeHead(200, {
      ...headers,
      "Content-Type": uploadContentType(name),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
      "Content-Length": String(st.size),
    });
    createReadStream(file).pipe(res);
    return;
  }

  if (req.method === "POST" && action === "upload") {
    const original = url.searchParams.get("filename") ?? "file";
    const name = uploadFileName(original);
    mkdirSync(UPLOAD_DIR, { recursive: true });
    const file = join(UPLOAD_DIR, name);
    const out = createWriteStream(file);
    let size = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_UPLOAD_BYTES) {
            req.destroy();
            out.destroy(new Error("文件过大"));
            reject(new Error("文件过大"));
            return;
          }
          if (!out.write(chunk)) req.pause();
        });
        out.on("drain", () => req.resume());
        req.on("end", () => out.end());
        out.on("finish", () => resolve());
        req.on("error", (e) => {
          out.destroy();
          reject(e);
        });
        out.on("error", (e) => {
          req.destroy();
          reject(e);
        });
      });
    } catch (e) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        /* ignore */
      }
      send(400, { ok: false, message: e instanceof Error ? e.message : "上传失败" });
      return;
    }
    send(200, { ok: true, name, size, originalName: original });
    return;
  }

  send(404, { ok: false, message: "没有这个接口" });
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, service: "hu-gong-yi-ti-public-relay" });
      return;
    }
    if (req.method === "GET" && path === "/") {
      sendJson(res, 200, { ok: true, service: "hu-gong-yi-ti-public-relay", routes: ROUTE_LIST });
      return;
    }
    if (path.startsWith("/api/up/")) {
      await handleUploadApi(req, res, url);
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, message: "只支持 POST" });
      return;
    }
    const handler = ROUTES[path];
    if (!handler) {
      sendJson(res, 404, { ok: false, message: "没有这个接口" });
      return;
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      throw new BadRequest("请求体不是合法 JSON");
    }
    if (!isObj(body)) throw new BadRequest("请求体必须是 JSON 对象");
    const result = await handler(body);
    sendJson(res, 200, result);
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof BadRequest) {
        sendJson(res, 400, { ok: false, message: e.message });
      } else {
        // 不把上游细节和堆栈打出去，也不记请求体。
        sendJson(res, 500, { ok: false, message: "服务器内部错误，请稍后再试" });
      }
    }
  } finally {
    const ms = Date.now() - started;
    console.log(`${req.method} ${path} ${res.statusCode} ${ms}ms`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`hu-gong-yi-ti-public-relay listening on 0.0.0.0:${PORT}`);
});
