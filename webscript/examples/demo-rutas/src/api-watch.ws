route("/api/watch")

server reactive var1 = 0
server var log = []

watch(var1)
    log = [...log, "var1 cambio a " + var1]

post function actualizar(args)
    var1 = args.valor
    return { var1: var1 }

get function estado(args)
    return { var1: var1, log: log }
