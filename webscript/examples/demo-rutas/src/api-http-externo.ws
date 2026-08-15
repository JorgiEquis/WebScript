route("/api/clima")

get function consultar(query)
    var datos = await http.get("https://api.ejemplo.com/clima?ciudad=" + query.ciudad, {})
    return { temperatura: datos.temp }

post function notificar(args)
    var resultado = await http.post("https://api.ejemplo.com/webhook", { mensaje: args.texto }, { "Authorization": "Bearer TOKEN" })
    return { enviado: true, respuesta: resultado }
