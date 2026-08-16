route("/api/enviar-fiable")

server wson sender =
    -> to: "http://sistema-inestable.invalido/recibir"
    -> content: "mensaje importante"
    -> retries: 3
    -> retryDelayMs: 500

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }

get function verDeadLetters(query)
    return { fallidos: WSON.history({ deadLetter: true }) }
