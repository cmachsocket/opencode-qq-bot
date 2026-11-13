import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte"
import { afterEach, describe, expect, it, vi } from "vitest"
import ToolProfilesPage from "../../web/src/routes/ToolProfilesPage.svelte"
import { stubFetch } from "./helpers"

/** 一个工具配置文件的接口返回。 */
function documentResponse(overrides: Record<string, unknown> = {}) {
  return {
    path: "/workspace/tool-profiles.json",
    exists: true,
    value: {
      defaultProfile: "chat",
      profiles: {
        chat: { allow: ["websearch", "qq_*"], deny: ["qq_diary_*"] },
        readonly: { allow: ["read"], deny: [] },
        admin: { allow: ["*"], deny: [] },
      },
      chats: { "group:100": "readonly" },
    },
    fileValue: {
      defaultProfile: "chat",
      profiles: { readonly: { allow: ["read"], deny: [] } },
      chats: { "group:100": "readonly" },
    },
    warnings: [],
    masked: [],
    ...overrides,
  }
}

/** 找到首列是这个名字的表格行。 */
function rowOf(name: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll("tr"))
  const row = rows.find((item) => item.querySelector("td")?.textContent?.trim().startsWith(name))
  if (!row) throw new Error(`找不到 ${name} 所在的行`)
  return row as HTMLElement
}

/** 在标签输入框里加一个标签。 */
function addTag(input: HTMLInputElement, tag: string): void {
  input.value = tag
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("工具档案页", () => {
  it("列出配置档，并标出内置档", async () => {
    stubFetch(() => ({ body: documentResponse() }))
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(rowOf("readonly")).toBeTruthy())
    const row = rowOf("readonly")
    expect(within(row).getByText("read")).toBeTruthy()
    // 文件里没写的档是内置档：标出来且不能删。
    expect(within(rowOf("chat")).getByText("内置")).toBeTruthy()
    expect(within(rowOf("chat")).getByText("删除").closest("button")?.disabled).toBe(true)
    expect(within(row).queryByText("内置")).toBeNull()
  })

  it("列出聊天映射", async () => {
    stubFetch(() => ({ body: documentResponse() }))
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    const row = rowOf("group:100")
    expect(within(row).getByText("readonly")).toBeTruthy()
  })

  it("新增配置档时提交名字与工具列表", async () => {
    const requests = stubFetch((request) => {
      if (request.method === "PUT") return { body: { ok: true, document: documentResponse() } }
      return { body: documentResponse() }
    })
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(rowOf("readonly")).toBeTruthy())
    screen.getByText("新增配置档").click()
    await waitFor(() => expect(screen.getByLabelText("档名")).toBeTruthy())
    const name = screen.getByLabelText("档名") as HTMLInputElement
    name.value = "custom"
    name.dispatchEvent(new Event("input", { bubbles: true }))
    const allow = screen.getByLabelText("allow") as HTMLInputElement
    addTag(allow, "read")
    await waitFor(() => expect(screen.getAllByText("read").length).toBeGreaterThan(0))
    screen.getByText("保存").click()
    await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true))
    const put = requests.find((item) => item.method === "PUT")
    expect(put?.url).toBe("/api/tool-profiles")
    expect(put?.body).toMatchObject({
      profiles: { custom: { allow: ["read"] } },
    })
  })

  it("删掉一个配置档时提交空补丁", async () => {
    const requests = stubFetch((request) => {
      if (request.method === "PUT") return { body: { ok: true, document: documentResponse() } }
      return { body: documentResponse() }
    })
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(rowOf("readonly")).toBeTruthy())
    within(rowOf("readonly")).getByText("删除").click()
    await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true))
    const put = requests.find((item) => item.method === "PUT")
    expect(put?.body).toEqual({ profiles: { readonly: null } })
  })

  it("删掉一个聊天映射时提交空补丁", async () => {
    const requests = stubFetch((request) => {
      if (request.method === "PUT") return { body: { ok: true, document: documentResponse() } }
      return { body: documentResponse() }
    })
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    within(rowOf("group:100")).getByText("删除").click()
    await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true))
    const put = requests.find((item) => item.method === "PUT")
    expect(put?.body).toEqual({ chats: { "group:100": null } })
  })

  it("新增聊天映射时提交聊天键与配置档", async () => {
    const requests = stubFetch((request) => {
      if (request.method === "PUT") return { body: { ok: true, document: documentResponse() } }
      return { body: documentResponse() }
    })
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    screen.getByText("新增映射").click()
    await waitFor(() => expect(screen.getByLabelText("聊天键")).toBeTruthy())
    const key = screen.getByLabelText("聊天键") as HTMLInputElement
    key.value = "private:200"
    key.dispatchEvent(new Event("input", { bubbles: true }))
    // 配置档用下拉选：先选一个再保存。
    const trigger = screen.getByLabelText("配置档")
    trigger.click()
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(0))
    const option = screen
      .getAllByRole("option")
      .find((item) => item.textContent?.trim() === "admin")
    if (!option) throw new Error("找不到 admin 选项")
    // bits-ui 的选项在 pointerup 时才选中。
    await fireEvent.pointerDown(option)
    await fireEvent.pointerUp(option)
    await waitFor(() => expect(screen.getByText("保存")).toBeTruthy())
    screen.getByText("保存").click()
    await waitFor(() => expect(requests.some((item) => item.method === "PUT")).toBe(true))
    const put = requests.find((item) => item.method === "PUT")
    expect(put?.body).toEqual({ chats: { "private:200": "admin" } })
  })

  it("服务端说校验不通过时把原因就地显示出来", async () => {
    stubFetch((request) => {
      if (request.method === "PUT") {
        return {
          status: 400,
          body: {
            error: "validation_failed",
            message: "工具配置校验不通过",
            fields: [
              { path: "chats.group:100", message: "chats.group:100 指向不存在的配置档 不存在的档" },
            ],
          },
        }
      }
      return { body: documentResponse() }
    })
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(screen.getByText("group:100")).toBeTruthy())
    within(rowOf("group:100")).getByText("编辑").click()
    await waitFor(() => expect(screen.getByLabelText("聊天键")).toBeTruthy())
    screen.getByText("保存").click()
    await waitFor(() =>
      expect(
        screen.getAllByText("chats.group:100 指向不存在的配置档 不存在的档").length,
      ).toBeGreaterThan(0),
    )
  })

  it("保存成功后给出可见的提示", async () => {
    stubFetch((request) => {
      if (request.method === "PUT") {
        return {
          body: {
            ok: true,
            restartRequired: false,
            note: "已保存，工具配置会在下一次工具调用前生效，无需重启。",
            warnings: [],
            document: documentResponse(),
          },
        }
      }
      return { body: documentResponse() }
    })
    render(ToolProfilesPage, { props: {} })
    await waitFor(() => expect(rowOf("readonly")).toBeTruthy())
    within(rowOf("readonly")).getByText("编辑").click()
    await waitFor(() => expect(screen.getByText("保存")).toBeTruthy())
    screen.getByText("保存").click()
    await waitFor(() => expect(screen.getByText(/无需重启/)).toBeTruthy())
  })
})
