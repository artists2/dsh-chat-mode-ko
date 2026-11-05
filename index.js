// 채팅 / 작업 이중 모드 플러그인의 Host 쪽 절반 (한국어판).
//
// 클라이언트(Renderer)는 모드 전환, 공식 웹 채팅 내장, 설정 페이지, "작업으로
// 가져오기" 를 담당합니다. Host 쪽은 그것과 별개로 **출처 링크 열기**만 제공합니다.
//
// 왜 Host 가 필요한가: 채팅 모드는 DeepSeek 공식 웹 채팅을 Electron <webview> 에
// 띄웁니다. 웹뷰에는 팝업 창이 없어서 페이지가 window.open(또는 target="_blank") 으로
// 여는 링크(답변의 출처/인용 링크)가 아무 일도 하지 않고 사라집니다. 렌더러에는
// OS 기본 브라우저를 여는 API 가 없으므로, 같은 출처의 작은 HTTP 경로를 하나 열어
// 렌더러가 URL 만 넘기면 Host 가 기본 브라우저로 엽니다.
//
// 안전 범위:
//   - http/https 주소만 열고, 사용자 이름/비밀번호가 붙은 주소는 거부합니다.
//   - 페이지 내용은 읽지 않습니다. 넘어온 URL 문자열만 검사해 엽니다.
//   - 경로는 이 플러그인 전용이며, 포트는 DSH 웹서버의 로컬 바인딩을 그대로 씁니다.
import { spawn } from 'node:child_process'

const ROUTE_PATH = '/chat-mode-ko/open'
const MAX_URL_LENGTH = 2048
const MAX_BODY_BYTES = 64 * 1024

/** https/http 주소만 허용하고 정규화한다. 그 밖에는 null. */
function normalizeExternalUrl(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0 || text.length > MAX_URL_LENGTH) return null
  if (/\s/.test(text)) return null
  let url
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  return url.toString()
}

/** OS 기본 브라우저로 연다. 실패해도 예외를 던지지 않는다. */
function openInDefaultBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => {})
      child.unref()
      return
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const child = spawn(command, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // 열지 못해도 채팅은 계속 동작해야 한다.
  }
}

/** 요청 본문을 JSON 으로 읽는다. 상한을 넘거나 JSON 이 아니면 null. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  if (size === 0) return null
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const disposeRoute = scope.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.writeHead(405, { allow: 'POST' })
            res.end()
            return
          }
          const body = await readJsonBody(req)
          if (body === null) {
            res.writeHead(400)
            res.end()
            return
          }

          const url = normalizeExternalUrl(body.url)
          if (url === null) {
            res.writeHead(400)
            res.end()
            return
          }
          openInDefaultBrowser(url)
          res.writeHead(204)
          res.end()
        } catch {
          try {
            res.writeHead(500)
            res.end()
          } catch {
            // 이미 응답을 보냈다.
          }
        }
      },
    })
    scope.effect(() => () => disposeRoute(), 'dsh-chat-mode-ko:open-external-route')
  })
}