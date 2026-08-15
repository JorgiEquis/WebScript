route("/api/contador")

server var total = 0

post function incrementar(args)
    total = total + args.cantidad
    return { total: total }
