route("/api/items-respond")

server var items = []

post function crear(args)
    if (!args.nombre)
        return respond(400, { error: "falta el nombre" })
    items = [...items, args.nombre]
    return respond(201, { creado: true, total: items.length })

get function listar(query)
    return items
