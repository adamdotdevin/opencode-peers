import { Plugin } from "@opencode/plugin/tui"
import type { DialogSelectOption } from "@opencode/plugin/tui/context"
import { Peers, type ListOutput, type PostOutput } from "./rpc.ts"

type Target = { type: "board" | "session"; id: string; name: string; detail?: string }

// /peers opens a picker of boards and live sessions, then asks for the message. /peers <id> <message> sends directly.
// A message to one session is a prompt from you, as if typed in it. A board post reaches every member.
export default Plugin.define({
  id: "peers.tui",
  setup(context) {
    const location = () => context.location ?? context.data.location.default()
    const peers = () => context.client.rpc(Peers)
    const current = () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    const deliver = async (target: Target, text: string) => {
      try {
        if (target.type === "session") {
          await context.client.session.prompt({ sessionID: target.id, text, delivery: "steer" })
          return context.ui.toast.show({ message: `Sent to ${target.name}`, variant: "success" })
        }
        const { delivered } = (await peers().post({ board: target.id, text }, { location: location() })) as PostOutput
        const names = (entries: PostOutput["delivered"]) => entries.map((entry) => entry.title || entry.id).join(", ")
        const missed = delivered.filter((entry) => entry.how.startsWith("not delivered") || entry.how.startsWith("gone"))
        if (missed.length === 0) return context.ui.toast.show({ message: `Sent to ${names(delivered)}`, variant: "success" })
        context.ui.toast.show({
          title: `Sent, but ${missed.length} of ${delivered.length} didn't get it`,
          message: names(missed),
          variant: "warning",
        })
      } catch (error) {
        const message = (error as { message?: unknown } | undefined)?.message
        context.ui.toast.show({
          title: "Not sent",
          ...(typeof message === "string" && message ? { message } : {}),
          variant: "error",
        } as { title: string; message: string; variant: "error" })
      }
    }

    const pick = async () => {
      const { boards, sessions } = (await peers().list(
        { ...(current() ? { sessionID: current() } : {}) },
        { location: location() },
      )) as ListOutput
      if (boards.length + sessions.length === 0) return context.ui.toast.show({ message: "No sessions to message" })
      const options: DialogSelectOption<Target>[] = [
        ...sessions.map((session) => ({
          title: session.title,
          description: session.where,
          footer: session.state === "busy" ? "working" : session.active,
          category: "Sessions",
          value: { type: "session", id: session.id, name: session.title } as Target,
        })),
        ...boards.map((board) => ({
          title: board.members.join(", "),
          footer: board.last?.active,
          category: "Groups",
          value: {
            type: "board",
            id: board.id,
            name: board.members.join(", "),
            detail: board.last && `${board.last.from}, ${board.last.active}: ${board.last.text}`,
          } as Target,
        })),
      ]
      // Escape in the message goes back to the list, on the row you came from; Escape in the list closes it.
      let last: Target | undefined
      for (;;) {
        const picked = context.ui.dialog.select({ title: "Message", placeholder: "Search", options, current: last })
        context.ui.dialog.set({ size: "large" })
        const target = await picked
        if (!target) return
        last = target
        const asked = context.ui.dialog.prompt({ title: target.name, description: target.detail, placeholder: "Message" })
        context.ui.dialog.set({ size: "large" })
        const text = (await asked)?.trim()
        if (text) return deliver(target, text)
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "peers.message",
          title: "Message another session",
          group: "Peers",
          palette: true,
          slash: { name: "peers", arguments: true },
          run: async (input) => {
            const raw = input?.trim() ?? ""
            if (!raw) return void (await pick())
            const id = raw.split(/\s+/)[0]!
            const text = raw.slice(id.length).trim()
            if (!/^(brd|ses)_/.test(id) || !text)
              return context.ui.toast.show({ title: "Usage", message: "/peers <ses_… or brd_…> <message>" })
            if (id.startsWith("brd_")) return void (await deliver({ type: "board", id, name: "" }, text))
            const session = await context.client.session.get({ sessionID: id }).catch(() => undefined)
            if (!session) return context.ui.toast.show({ message: `No session ${id}`, variant: "error" })
            await deliver({ type: "session", id, name: session.title || id }, text)
          },
        },
      ],
    }))
  },
})
