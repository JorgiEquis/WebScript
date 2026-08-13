route("/")

reactive contador = 0

style boton =
    -> background-color: teal
    -> color: white

visual home =
<div>
    <h1>Página de inicio</h1>
    <p>Contador: {contador}</p>
</div>
    -> style: boton
    -> onclick:
        contador++

render(
    home
)
