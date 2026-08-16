route("/api/wson-enviar")

server var mensajeTexto = "Hola desde WSON"

server wson sender =
    -> from: "sistema-a"
    -> to: "http://ejemplo-sistema-b.invalido/recibir"
    -> via: "POST"
    -> content: mensajeTexto

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuestaDelOtroSistema: r }
