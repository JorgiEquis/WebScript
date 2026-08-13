reactive nombre = "Jorge"
reactive edad = 25
reactive precio = 19.99
reactive activo = true
reactive cantidad = 3

style boton =
    -> background-color: teal
    -> color: white

visual resumen =
<div>
    <p>Hola {nombre}, tienes {edad} años</p>
    <p>Total: {precio * cantidad}</p>
    if (activo)
        <p>Cuenta activa</p>
    else
        <p>Cuenta inactiva</p>
    if (edad >= 18)
        <p>{nombre} es mayor de edad</p>
</div>

visual subirPrecio =
<button>
    Subir cantidad
</button>
    -> style: boton
    -> onclick:
        cantidad = cantidad + 1

render(
    resumen,
    subirPrecio
)
