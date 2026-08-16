route("/api/enviar-multi")

server wson sender =
    -> from: "servicio-de-pagos"
    -> to: ["http://ejemplo-a.invalido/recibir", "http://ejemplo-b.invalido/recibir"]
    -> content: "pago confirmado"
    -> secret: "clave-compartida"

post function disparar(args)
    var r = await WSON.send(sender)
    return { resultados: r }

get function verHistorial(query)
    return { historial: WSON.history() }
