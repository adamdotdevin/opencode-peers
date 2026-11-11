import { Plugin } from "@opencode/plugin/tui"
import { Peers, type ListOutput } from "./rpc.ts"

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
        const { delivered } = (await peers().post({ board: target.id, text }, { location: location() })) as ListPost
        const missed = delivered.filter((entry) => entry.how.startsWith("not delivered") || entry.how.startsWith("gone"))
        if (missed.length === 0) return context.ui.toast.show({ message: `Sent to ${target.name}`, variant: "success" })
        context.ui.toast.show({
          title: `Sent, but ${missed.length} of ${delivered.length} didn't get it`,
          message: missed.map((entry) => `${entry.title || entry.id}: ${entry.how}`).join("\n"),
          variant: "warning",
        })
      } catch (error) {
        context.ui.toast.show({ title: "Not sent", message: error instanceof Error ? error.message : String(error), variant: "error" })
      }
    }

    const pick = async () => {
      const { boards, sessions } = (await peers().list(
        { ...(current() ? { sessionID: current() } : {}) },
        { location: location() },
      )) as ListOutput
      if (boards.length + sessions.length === 0)
        return context.ui.toast.show({ message: "No other sessions are running" })
      const options = [
        ...boards.map((board) => ({
          title: board.members.join(", "),
          description: board.last,
          category: "Groups",
          value: { type: "board", id: board.id, name: board.members.join(", "), detail: board.last } as Target,
        })),
        ...sessions.map((session) => ({
          title: session.title,
          description: `${session.where} · ${session.state === "busy" ? "working" : session.active}`,
          category: "Sessions",
          value: { type: "session", id: session.id, name: session.title, detail: session.where } as Target,
        })),
      ]
      const target = await context.ui.dialog.select({ title: "Message", placeholder: "Search", options })
      if (!target) return
      const text = await context.ui.dialog.prompt({ title: target.name, description: target.detail })
      if (text?.trim()) await deliver(target, text.trim())
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
              return context.ui.toast.show({ message: "Use /peers on its own to pick, or /peers <brd_… or ses_…> <message>" })
            const name = id.startsWith("ses_") ? (context.data.session.get(id)?.title ?? id) : id
            await deliver({ type: id.startsWith("ses_") ? "session" : "board", id, name }, text)
          },
        },
      ],
    }))
  },
})

type ListPost = { delivered: { id: string; title: string; how: string }[] }
