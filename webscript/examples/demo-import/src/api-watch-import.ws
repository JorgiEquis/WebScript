route("/api/watch-import")

import { updateVar } from "./compartido-watch.ws"

post function disparar(args)
    updateVar()
    return { ok: true }
