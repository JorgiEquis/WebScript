server var contador
server var num1

reactive contadorCliente = 0

style boton =
    -> background-color: teal
    -> color: white

visual panel =
<button class={boton} onclick={contadorCliente++}>
    Cliente: {contadorCliente}
</button>

render(
    panel
)
