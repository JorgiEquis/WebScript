route("/api/consultar-externo")

server function llamarFuera(url)
    var r = http.get(url, {})
    return r

post function usar(args)
    var datos = llamarFuera(args.url)
    return { recibido: datos }
