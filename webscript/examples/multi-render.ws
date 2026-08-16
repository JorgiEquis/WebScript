reactive contador = 0

style boton =
    -> background-color: blue
    -> color: white
    -> border: none

visual encabezado =
<h1>
    Mi App
</h1>

visual contadorBtn =
<button class={boton} onclick={contador++}>
    Clicks: {contador}
</button>

visual pie =
<footer>
    Hecho con WebScript
</footer>

render(
    encabezado,
    contadorBtn,
    pie
)
