route("/api/enviar-cifrado")

server var datosSecretos = "numero de tarjeta: 4111-1111-1111-1111"

server wson sender =
    -> to: "http://ejemplo-sistema-b.invalido/recibir"
    -> content: datosSecretos
    -> secret: "clave-compartida-super-secreta"
    -> encrypt: true

post function disparar(args)
    var r = await WSON.send(sender)
    return { respuesta: r }
