route("/formulario")

server var totalPedidos = 0

post function postController(args)
    totalPedidos = totalPedidos + args.cantidad
    return { totalPedidos: totalPedidos, mensaje: "Pedido registrado" }

reactive total = 0
reactive mensaje = ""

style boton =
    -> background-color: #dc2626
    -> color: white
    -> border: none
    -> padding: 8px 16px

visual paginaFormulario =
<div>
    <h1>Formulario</h1>
    <p>Total acumulado: {total}</p>
    <p>{mensaje}</p>
</div>
    -> style: boton
    -> onclick:
        var resultado = await postController({ cantidad: 5 })
        total = resultado.totalPedidos
        mensaje = resultado.mensaje

render(
    paginaFormulario
)
