route("/api/tareas")

server var tareas = []

post function crear(args)
    tareas = [...tareas, { id: tareas.length, texto: args.texto }]
    return { tareas: tareas }

put function actualizar(args)
    tareas = tareas.map(t => t.id == args.id ? { id: t.id, texto: args.texto } : t)
    return { tareas: tareas }

delete function borrar(args)
    tareas = tareas.filter(t => t.id != args.id)
    return { tareas: tareas }
