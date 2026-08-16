route("/api/enviar-firmado")

server var mensajeTexto = "pago confirmado: 42.50"

server wson sender =
    -> to: "http://ejemplo-sistema-b.invalido/recibir"
    -> content: mensajeTexto
    -> secret: "clave-compartida-entre-los-dos-sistemas"

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
