import { render, screen, waitFor, within } from "@testing-library/svelte"
import { afterEach, describe, expect, it, vi } from "vitest"
import ChatOverridesPage from "../../web/src/routes/ChatOverridesPage.svelte"
import { stubFetch } from "./helpers"

/** 一个会话覆盖文件的接口返回。 */
function documentResponse(overrides: Record<string, unknown> = {}) {
  return {
    path: "/workspace/chat-overrides.json",
    exists: true,
    value: {
      chats: {
        "group:100": { wake: "mention", agent: "build" },
        "private:200": { "proactive.enabled": false },
      },
    },
    fileValue: {
      chats: {
        "group:100": { wake: "mention", agent: "build" },
        "private:200": { "proactive.enabled": false },
      },
    },
    warnings: [],
    masked: [],
    ...overrides,
  }
}

/** 找到某个聊天键所在的表格行。 */
function rowOf(key: string): HTMLElement {
  const cell = screen.getByText(key)
  const row = cell.closest("tr")
  if (!row) throw new Error(`找不到 ${key} 所在的行`)
  return row as HTMLElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("会话覆盖页", () => {
  it("列出服务端返回的聊天键与覆盖项", async () => {
    stubFetch(() => ({ body: documentResponse() }))
    render(ChatOverridesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    expect(screen.getByText("private:200")).toBeTruthy()
    const row = rowOf("group:100")
    expect(within(row).getByText("mention")).toBeTruthy()
    expect(within(row).getByText("build")).toBeTruthy()
  })

  it("打开编辑表单时填入当前生效的值", async () => {
    stubFetch(() => ({ body: documentResponse() }))
    render(ChatOverridesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    within(rowOf("group:100")).getByText("编辑").click()
    await waitFor(() => expect(screen.getByLabelText("聊天键")).toBeTruthy())
    const key = screen.getByLabelText("聊天键") as HTMLInputElement
    expect(key.value).toBe("group:100")
    const agent = screen.getByLabelText("agent") as HTMLInputElement
    expect(agent.value).toBe("build")
  })

  it("保存时只提交这个聊天的改动", async () => {
    const requests = stubFetch((request) => {
      if (request.method === "PUT") return { body: { ok: true, document: documentResponse() } }
      return { body: documentResponse() }
    })
    render(ChatOverridesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    within(rowOf("group:100")).getByText("编辑").click()
    await waitFor(() => expect(screen.getByLabelText("agent")).toBeTruthy())
    const agent = screen.getByLabelText("agent") as HTMLInputElement
    agent.value = "ops"
    agent.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(() => expect(screen.getByText("保存")).toBeTruthy())
    screen.getByText("保存").click()
    await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true))
    const put = requests.find((item) => item.method === "PUT")
    expect(put?.url).toBe("/api/chat-overrides")
    expect(put?.body).toMatchObject({
      chats: { "group:100": { agent: "ops" } },
    })
  })

  it("删除一个聊天时提交空补丁", async () => {
    const requests = stubFetch((request) => {
      if (request.method === "PUT") return { body: { ok: true, document: documentResponse() } }
      return { body: documentResponse() }
    })
    render(ChatOverridesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    within(rowOf("group:100")).getByText("删除").click()
    await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true))
    const put = requests.find((item) => item.method === "PUT")
    expect(put?.body).toEqual({ chats: { "group:100": null } })
  })

  it("服务端说校验不通过时把原因就地显示出来", async () => {
    stubFetch((request) => {
      if (request.method === "PUT") {
        return {
          status: 400,
          body: {
            error: "validation_failed",
            message: "会话覆盖校验不通过",
            fields: [{ path: "chats.abc", message: "聊天键必须是 group:<群号> 或 private:<账号>" }],
          },
        }
      }
      return { body: documentResponse() }
    })
    render(ChatOverridesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    within(rowOf("group:100")).getByText("编辑").click()
    await waitFor(() => expect(screen.getByLabelText("聊天键")).toBeTruthy())
    screen.getByText("保存").click()
    await waitFor(() =>
      expect(screen.getByText("聊天键必须是 group:<群号> 或 private:<账号>")).toBeTruthy(),
    )
  })

  it("保存成功后给出可见的提示", async () => {
    stubFetch((request) => {
      if (request.method === "PUT") {
        return {
          body: {
            ok: true,
            restartRequired: false,
            note: "已保存，会话覆盖会在下一条消息到达时生效，无需重启。",
            warnings: [],
            document: documentResponse(),
          },
        }
      }
      return { body: documentResponse() }
    })
    render(ChatOverridesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    within(rowOf("group:100")).getByText("编辑").click()
    await waitFor(() => expect(screen.getByText("保存")).toBeTruthy())
    screen.getByText("保存").click()
    await waitFor(() => expect(screen.getByText(/无需重启/)).toBeTruthy())
  })

  it("解析告警会显示出来", async () => {
    stubFetch(() => ({
      body: documentResponse({ warnings: ["会话覆盖 group:100 的 wake 不是支持的取值，已忽略"] }),
    }))
    render(ChatOverridesPage, { props: {} })
    await waitFor(() => expect(screen.getByText(/wake 不是支持的取值/)).toBeTruthy())
  })
})
