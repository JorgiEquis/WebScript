route("/api/usuario")

server var nombre = "Jorge"
server var visitas = 100

get function estado(args)
    return { saludo: "Hola, " + (args.nombre || nombre), visitasTotales: visitas * 2 }

post function incrementar(args)
    visitas = visitas + 1
    return { visitas: visitas }
