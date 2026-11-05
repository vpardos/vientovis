/* vientovis_ventilador — Arduino (Uno/Nano) que hace de salida física de la
 * visualización: ventilador = viento, servo = categoría Saffir–Simpson.
 *
 * PROTOCOLO (9600 bauds, una línea por comando, terminadas en '\n'):
 *   F<0-100>  duty del ventilador (PWM, pin 6)
 *   S<0-180>  ángulo del servo MG90S (pin 5)
 *   D         suelta el servo (detach inmediato)
 *
 * SOLTADO AUTOMÁTICO: el servo se suelta solo MS_SOLTAR ms después de su
 * último movimiento. Un MG90S sosteniendo posición consume corriente todo el
 * tiempo (20-40 mA sin carga, 300-700 mA si algo lo frena), y la página no
 * necesita que sostenga nada: el ángulo queda donde lo dejó. Al llegar el
 * siguiente comando 'S' se vuelve a acoplar y se mueve a la nueva posición.
 *
 * CABLEADO (importante):
 *   - Ventilador: 12 V externos conmutados por MOSFET + diodo de rueda libre.
 *     Nunca desde un pin.
 *   - Servo MG90S: fuente propia de 5-6 V con GND COMÚN al Arduino. En bloqueo
 *     tira ~700 mA; el 5 V del USB (polifusor de 500 mA) no está pensado para
 *     eso y el síntoma es un brownout que resetea la placa.
 *   - Serial por USB: solo datos.
 */

#include <Servo.h>

Servo s;
const int SERVO_PIN = 5;
const int FAN_PIN = 6;

const unsigned long MS_SOLTAR = 500;  // soltado automático tras el último 'S'
const int ANGULO_INICIAL = 30;        // posición de reposo de la aguja

bool servoAcoplado = false;
unsigned long msUltimoMovimiento = 0;

void acoplar() {
  if (servoAcoplado) return;
  s.attach(SERVO_PIN, 500, 2400);
  servoAcoplado = true;
}

void soltar() {
  if (!servoAcoplado) return;
  s.detach();
  servoAcoplado = false;
}

void setup() {
  Serial.begin(9600);
  pinMode(FAN_PIN, OUTPUT);
  analogWrite(FAN_PIN, 0);
  /* arranca en la posición de reposo (30°, la de TD/tormenta tropical) en vez
   * de en el centro: al encender no se ve un barrido de 90° a 30° */
  acoplar();
  s.write(ANGULO_INICIAL);
  msUltimoMovimiento = millis();
}

void loop() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    /* línea vacía o ruido: no toca nada (y no corta el chequeo de soltado) */
    if (cmd.length() > 0) {
      char c = cmd[0];
      if (c == 'F') {
        int p = constrain(cmd.substring(1).toInt(), 0, 100);
        analogWrite(FAN_PIN, map(p, 0, 100, 0, 255));
      } else if (c == 'S') {
        int a = constrain(cmd.substring(1).toInt(), 0, 180);
        acoplar();
        s.write(a);
        msUltimoMovimiento = millis();
      } else if (c == 'D') {
        soltar();
      }
    }
  }

  /* soltado automático: se queda acoplado solo mientras lo están moviendo */
  if (servoAcoplado && millis() - msUltimoMovimiento >= MS_SOLTAR) soltar();
}
