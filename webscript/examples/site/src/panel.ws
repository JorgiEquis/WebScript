route("/panel")

server var visitas = 42

reactive contadorCliente = server.visitas

style boton =
    -> background-color: purple
    -> color: white

visual panelServidor =
<div>
    <h1>Panel</h1>
    <p>Visitas (servidor): {contadorCliente}</p>
</div>
    -> style: boton
    -> onclick:
        contadorCliente = await updateServer({ visitas: contadorCliente + 1 }).then(s => s.visitas)

render(
    panelServidor
)
