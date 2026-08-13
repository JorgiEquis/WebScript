server var contador
server var num1

reactive contadorCliente = 0

style boton =
    -> background-color: teal
    -> color: white

visual panel =
<button>
    Cliente: {contadorCliente}
</button>
    -> style: boton
    -> onclick:
        contadorCliente++

render(
    panel
)
