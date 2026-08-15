route("/api/crear-con-contexto")

server var items = []

post function crear(args, query, headers)
    items = [...items, { texto: args.texto, prioridad: query.prioridad || "normal", agente: headers["user-agent"] || "desconocido" }]
    return { items: items }

get function listar(query, headers)
    return { total: items.length, filtro: query.filtro || "ninguno", tieneAuth: headers["authorization"] ? true : false }
