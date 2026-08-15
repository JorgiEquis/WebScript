route("/api/consultar-externo")

async server function llamarFuera(url)
    var r = await http.get(url, {})
    return r

post function usar(args)
    var datos = await llamarFuera(args.url)
    return { recibido: datos }
