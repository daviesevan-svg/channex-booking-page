// Built-in guest-email copy in every guest language.
//
// `.server` on purpose: content.ts is in the client bundle (the admin editor
// reads the English field defaults from EMAIL_TEMPLATES), and ~150 translated
// paragraphs would ship to every guest browser for nothing — the same trap the
// admin dictionaries fell into before PR437. Emails are composed on the server
// only, so the translations live here.
//
// Only GUEST-facing templates are translated. Host-facing ones
// (host_notification, cancellation_notification) always render in the default
// language — the recipient is the hotelier, and their guest's language says
// nothing about theirs (email.server pins those sends to DEFAULT_LANG).
//
// Keep {tokens} byte-identical to the English defaults in content.ts, and keep
// any button named in prose (the confirmation outro quotes "Manage booking")
// in sync with that language's `manageBooking` label in app/lib/locales/*.
import { DEFAULT_LANG, emailDef } from "./content";

const EMAIL_TRANSLATIONS: Record<string, Record<string, Record<string, string>>> = {
  booking_confirmation: {
    fr: {
      subject: "Votre réservation à {hotel_name} est confirmée ({reference})",
      heading: "C'est réservé, {guest_first_name} !",
      intro:
        "Merci d'avoir réservé en direct auprès de {hotel_name}. Voici les détails de votre séjour — nous avons hâte de vous accueillir.",
      outro: "Besoin de modifier quelque chose ? Utilisez le bouton « Gérer la réservation » ci-dessus à tout moment. À très bientôt !",
    },
    de: {
      subject: "Ihre Buchung bei {hotel_name} ist bestätigt ({reference})",
      heading: "Ihre Buchung steht, {guest_first_name}!",
      intro:
        "Danke, dass Sie direkt bei {hotel_name} gebucht haben. Hier sind die Details Ihres Aufenthalts — wir freuen uns darauf, Sie willkommen zu heißen.",
      outro: "Möchten Sie etwas ändern? Nutzen Sie jederzeit die Schaltfläche „Buchung verwalten“ oben. Bis bald!",
    },
    es: {
      subject: "Tu reserva en {hotel_name} está confirmada ({reference})",
      heading: "¡Reserva hecha, {guest_first_name}!",
      intro:
        "Gracias por reservar directamente con {hotel_name}. Aquí tienes los detalles de tu estancia: estamos deseando darte la bienvenida.",
      outro: "¿Necesitas hacer algún cambio? Usa el botón «Gestionar reserva» de arriba cuando quieras. ¡Hasta pronto!",
    },
    it: {
      subject: "La tua prenotazione presso {hotel_name} è confermata ({reference})",
      heading: "Prenotazione fatta, {guest_first_name}!",
      intro:
        "Grazie per aver prenotato direttamente con {hotel_name}. Ecco i dettagli del tuo soggiorno — non vediamo l'ora di darti il benvenuto.",
      outro: "Devi modificare qualcosa? Usa in qualsiasi momento il pulsante «Gestisci prenotazione» qui sopra. A presto!",
    },
    pt: {
      subject: "A sua reserva em {hotel_name} está confirmada ({reference})",
      heading: "Reserva feita, {guest_first_name}!",
      intro:
        "Obrigado por reservar diretamente com {hotel_name}. Aqui estão os detalhes da sua estadia — mal podemos esperar para o receber.",
      outro: "Precisa de alterar alguma coisa? Use o botão «Gerir reserva» acima a qualquer momento. Até breve!",
    },
    nl: {
      subject: "Je boeking bij {hotel_name} is bevestigd ({reference})",
      heading: "Geboekt, {guest_first_name}!",
      intro:
        "Bedankt dat je rechtstreeks bij {hotel_name} hebt geboekt. Hier zijn de details van je verblijf — we kijken ernaar uit je te verwelkomen.",
      outro: "Wil je iets wijzigen? Gebruik op elk moment de knop ‘Boeking beheren’ hierboven. Tot snel!",
    },
    el: {
      subject: "Η κράτησή σας στο {hotel_name} επιβεβαιώθηκε ({reference})",
      heading: "Η κράτηση έγινε, {guest_first_name}!",
      intro:
        "Ευχαριστούμε που κάνατε κράτηση απευθείας στο {hotel_name}. Ακολουθούν τα στοιχεία της διαμονής σας — ανυπομονούμε να σας υποδεχτούμε.",
      outro: "Θέλετε να αλλάξετε κάτι; Χρησιμοποιήστε οποιαδήποτε στιγμή το κουμπί «Διαχείριση κράτησης» παραπάνω. Τα λέμε σύντομα!",
    },
    th: {
      subject: "การจองของคุณที่ {hotel_name} ได้รับการยืนยันแล้ว ({reference})",
      heading: "จองสำเร็จแล้ว คุณ{guest_first_name}!",
      intro: "ขอบคุณที่จองโดยตรงกับ {hotel_name} นี่คือรายละเอียดการเข้าพักของคุณ — เรารอต้อนรับคุณอยู่",
      outro: "ต้องการเปลี่ยนแปลงหรือไม่ ใช้ปุ่ม “จัดการการจอง” ด้านบนได้ตลอดเวลา แล้วพบกัน!",
    },
    tr: {
      subject: "{hotel_name} rezervasyonunuz onaylandı ({reference})",
      heading: "Rezervasyon tamam, {guest_first_name}!",
      intro:
        "{hotel_name} ile doğrudan rezervasyon yaptığınız için teşekkürler. Konaklamanızın ayrıntıları aşağıda — sizi ağırlamak için sabırsızlanıyoruz.",
      outro: "Bir değişiklik mi gerekiyor? Yukarıdaki “Rezervasyonu yönet” düğmesini istediğiniz zaman kullanabilirsiniz. Görüşmek üzere!",
    },
  },
  booking_cancellation: {
    fr: {
      subject: "Votre réservation à {hotel_name} a été annulée ({reference})",
      heading: "Votre réservation est annulée",
      intro:
        "Nous avons annulé votre réservation à {hotel_name}, {guest_first_name}. Les détails de la réservation annulée figurent ci-dessous.",
      outro: "Si vous n'êtes pas à l'origine de cette demande, contactez-nous immédiatement.",
    },
    de: {
      subject: "Ihre Buchung bei {hotel_name} wurde storniert ({reference})",
      heading: "Ihre Buchung ist storniert",
      intro:
        "Wir haben Ihre Buchung bei {hotel_name} storniert, {guest_first_name}. Die Details der stornierten Reservierung finden Sie unten.",
      outro: "Falls Sie das nicht veranlasst haben, kontaktieren Sie uns bitte umgehend.",
    },
    es: {
      subject: "Tu reserva en {hotel_name} ha sido cancelada ({reference})",
      heading: "Tu reserva está cancelada",
      intro:
        "Hemos cancelado tu reserva en {hotel_name}, {guest_first_name}. Abajo tienes los detalles de la reserva cancelada.",
      outro: "Si no lo has solicitado tú, contáctanos de inmediato.",
    },
    it: {
      subject: "La tua prenotazione presso {hotel_name} è stata cancellata ({reference})",
      heading: "La tua prenotazione è cancellata",
      intro:
        "Abbiamo cancellato la tua prenotazione presso {hotel_name}, {guest_first_name}. Qui sotto trovi i dettagli della prenotazione cancellata.",
      outro: "Se non l'hai richiesto tu, contattaci subito.",
    },
    pt: {
      subject: "A sua reserva em {hotel_name} foi cancelada ({reference})",
      heading: "A sua reserva está cancelada",
      intro:
        "Cancelámos a sua reserva em {hotel_name}, {guest_first_name}. Os detalhes da reserva cancelada estão abaixo.",
      outro: "Se não pediu este cancelamento, contacte-nos de imediato.",
    },
    nl: {
      subject: "Je boeking bij {hotel_name} is geannuleerd ({reference})",
      heading: "Je boeking is geannuleerd",
      intro:
        "We hebben je boeking bij {hotel_name} geannuleerd, {guest_first_name}. De details van de geannuleerde reservering staan hieronder.",
      outro: "Heb je dit niet zelf aangevraagd? Neem dan direct contact met ons op.",
    },
    el: {
      subject: "Η κράτησή σας στο {hotel_name} ακυρώθηκε ({reference})",
      heading: "Η κράτησή σας ακυρώθηκε",
      intro:
        "Ακυρώσαμε την κράτησή σας στο {hotel_name}, {guest_first_name}. Τα στοιχεία της ακυρωμένης κράτησης βρίσκονται παρακάτω.",
      outro: "Αν δεν το ζητήσατε εσείς, επικοινωνήστε μαζί μας αμέσως.",
    },
    th: {
      subject: "การจองของคุณที่ {hotel_name} ถูกยกเลิกแล้ว ({reference})",
      heading: "การจองของคุณถูกยกเลิกแล้ว",
      intro: "เราได้ยกเลิกการจองของคุณที่ {hotel_name} แล้ว คุณ{guest_first_name} รายละเอียดการจองที่ยกเลิกอยู่ด้านล่าง",
      outro: "หากคุณไม่ได้ขอยกเลิก โปรดติดต่อเราทันที",
    },
    tr: {
      subject: "{hotel_name} rezervasyonunuz iptal edildi ({reference})",
      heading: "Rezervasyonunuz iptal edildi",
      intro: "{hotel_name} rezervasyonunuzu iptal ettik, {guest_first_name}. İptal edilen rezervasyonun ayrıntıları aşağıda.",
      outro: "Bunu siz talep etmediyseniz lütfen hemen bizimle iletişime geçin.",
    },
  },
  booking_failed: {
    fr: {
      subject: "Nous n'avons pas pu confirmer votre réservation à {hotel_name} ({reference})",
      heading: "Désolé, {guest_first_name} — nous n'avons pas pu confirmer votre réservation",
      intro:
        "Malheureusement, la chambre s'est vendue avant la fin de votre paiement et nous n'avons pas pu confirmer votre séjour à {hotel_name}. Nous avons remboursé {refund_amount} en intégralité sur votre carte — cela peut prendre quelques jours.",
      outro: "Nous sommes désolés de cette déception. Essayez d'autres dates, et n'hésitez pas à nous contacter si nous pouvons vous aider.",
    },
    de: {
      subject: "Wir konnten Ihre Buchung bei {hotel_name} nicht bestätigen ({reference})",
      heading: "Es tut uns leid, {guest_first_name} — wir konnten Ihre Buchung nicht bestätigen",
      intro:
        "Leider war das Zimmer ausverkauft, bevor Ihre Zahlung abgeschlossen war, sodass wir Ihren Aufenthalt bei {hotel_name} nicht bestätigen konnten. Wir haben {refund_amount} vollständig auf Ihre Karte erstattet — es kann einige Tage dauern, bis der Betrag erscheint.",
      outro: "Die Enttäuschung tut uns leid. Versuchen Sie es gern mit anderen Daten — und melden Sie sich, wenn wir helfen können.",
    },
    es: {
      subject: "No hemos podido confirmar tu reserva en {hotel_name} ({reference})",
      heading: "Lo sentimos, {guest_first_name}: no hemos podido confirmar tu reserva",
      intro:
        "Lamentablemente, la habitación se agotó antes de completarse tu pago, así que no hemos podido confirmar tu estancia en {hotel_name}. Te hemos reembolsado {refund_amount} íntegramente en tu tarjeta; puede tardar unos días en aparecer.",
      outro: "Sentimos la decepción. Prueba con otras fechas y escríbenos si podemos ayudarte.",
    },
    it: {
      subject: "Non siamo riusciti a confermare la tua prenotazione presso {hotel_name} ({reference})",
      heading: "Ci dispiace, {guest_first_name} — non siamo riusciti a confermare la tua prenotazione",
      intro:
        "Purtroppo la camera è andata esaurita prima che il pagamento fosse completato, quindi non abbiamo potuto confermare il tuo soggiorno presso {hotel_name}. Ti abbiamo rimborsato integralmente {refund_amount} sulla carta — potrebbero volerci alcuni giorni.",
      outro: "Ci dispiace per la delusione. Prova con altre date e scrivici se possiamo aiutarti.",
    },
    pt: {
      subject: "Não conseguimos confirmar a sua reserva em {hotel_name} ({reference})",
      heading: "Lamentamos, {guest_first_name} — não conseguimos confirmar a sua reserva",
      intro:
        "Infelizmente, o quarto esgotou antes de o seu pagamento ficar concluído, pelo que não conseguimos confirmar a sua estadia em {hotel_name}. Reembolsámos {refund_amount} na totalidade para o seu cartão — pode demorar alguns dias a aparecer.",
      outro: "Lamentamos a desilusão. Experimente outras datas e fale connosco se pudermos ajudar.",
    },
    nl: {
      subject: "We konden je boeking bij {hotel_name} niet bevestigen ({reference})",
      heading: "Sorry, {guest_first_name} — we konden je boeking niet bevestigen",
      intro:
        "Helaas was de kamer uitverkocht voordat je betaling was afgerond, dus we konden je verblijf bij {hotel_name} niet bevestigen. We hebben {refund_amount} volledig teruggestort op je kaart — het kan een paar dagen duren voordat je het ziet.",
      outro: "Sorry voor de teleurstelling. Probeer andere data, en neem gerust contact op als we kunnen helpen.",
    },
    el: {
      subject: "Δεν μπορέσαμε να επιβεβαιώσουμε την κράτησή σας στο {hotel_name} ({reference})",
      heading: "Λυπούμαστε, {guest_first_name} — δεν μπορέσαμε να επιβεβαιώσουμε την κράτησή σας",
      intro:
        "Δυστυχώς το δωμάτιο εξαντλήθηκε πριν ολοκληρωθεί η πληρωμή σας, οπότε δεν μπορέσαμε να επιβεβαιώσουμε τη διαμονή σας στο {hotel_name}. Επιστρέψαμε πλήρως {refund_amount} στην κάρτα σας — ίσως χρειαστούν λίγες ημέρες για να εμφανιστεί.",
      outro: "Λυπούμαστε για την απογοήτευση. Δοκιμάστε άλλες ημερομηνίες και επικοινωνήστε μαζί μας αν μπορούμε να βοηθήσουμε.",
    },
    th: {
      subject: "เราไม่สามารถยืนยันการจองของคุณที่ {hotel_name} ({reference})",
      heading: "ขออภัย คุณ{guest_first_name} — เราไม่สามารถยืนยันการจองของคุณได้",
      intro:
        "น่าเสียดายที่ห้องพักถูกจองเต็มก่อนการชำระเงินของคุณจะเสร็จสมบูรณ์ เราจึงไม่สามารถยืนยันการเข้าพักของคุณที่ {hotel_name} ได้ เราได้คืนเงิน {refund_amount} เต็มจำนวนไปยังบัตรของคุณแล้ว — อาจใช้เวลาสองสามวันจึงจะปรากฏ",
      outro: "ขออภัยที่ทำให้ผิดหวัง ลองเลือกวันอื่นดู และติดต่อเราได้เสมอหากต้องการความช่วยเหลือ",
    },
    tr: {
      subject: "{hotel_name} rezervasyonunuzu onaylayamadık ({reference})",
      heading: "Üzgünüz {guest_first_name} — rezervasyonunuzu onaylayamadık",
      intro:
        "Ne yazık ki ödemeniz tamamlanmadan oda tükendi ve {hotel_name} konaklamanızı onaylayamadık. {refund_amount} tutarının tamamını kartınıza iade ettik — görünmesi birkaç gün sürebilir.",
      outro: "Yaşattığımız hayal kırıklığı için üzgünüz. Farklı tarihler deneyin; yardımcı olabileceksek bize yazın.",
    },
  },
  review_request: {
    fr: {
      subject: "Comment s'est passé votre séjour à {hotel_name} ?",
      subject2: "Une minute pour noter votre séjour, {guest_first_name} ?",
      subject3: "Dernière chance de donner votre avis sur {hotel_name}",
      heading: "Comment s'est passé votre séjour, {guest_first_name} ?",
      intro:
        "Merci d'avoir séjourné à {hotel_name}. Nous aimerions savoir comment cela s'est passé — votre avis nous aide à nous améliorer et aide les futurs voyageurs à choisir.\n\nCela ne prend qu'une minute — appuyez simplement sur une étoile ci-dessous pour commencer.",
    },
    de: {
      subject: "Wie war Ihr Aufenthalt bei {hotel_name}?",
      subject2: "Eine Minute, um Ihren Aufenthalt zu bewerten, {guest_first_name}?",
      subject3: "Letzte Gelegenheit, {hotel_name} zu bewerten",
      heading: "Wie war Ihr Aufenthalt, {guest_first_name}?",
      intro:
        "Danke für Ihren Aufenthalt bei {hotel_name}. Wir würden gern erfahren, wie es war — Ihr Feedback hilft uns, besser zu werden, und künftigen Gästen bei der Wahl.\n\nEs dauert nur eine Minute — tippen Sie einfach unten auf einen Stern, um zu beginnen.",
    },
    es: {
      subject: "¿Qué tal tu estancia en {hotel_name}?",
      subject2: "¿Un minuto para valorar tu estancia, {guest_first_name}?",
      subject3: "Última oportunidad para valorar tu estancia en {hotel_name}",
      heading: "¿Qué tal tu estancia, {guest_first_name}?",
      intro:
        "Gracias por alojarte en {hotel_name}. Nos encantaría saber cómo fue: tu opinión nos ayuda a mejorar y ayuda a futuros huéspedes a elegir.\n\nSolo te llevará un minuto: toca una estrella abajo para empezar.",
    },
    it: {
      subject: "Com'è andato il tuo soggiorno presso {hotel_name}?",
      subject2: "Un minuto per valutare il tuo soggiorno, {guest_first_name}?",
      subject3: "Ultima occasione per recensire il tuo soggiorno presso {hotel_name}",
      heading: "Com'è andato il tuo soggiorno, {guest_first_name}?",
      intro:
        "Grazie per aver soggiornato presso {hotel_name}. Ci piacerebbe sapere com'è andata — il tuo feedback ci aiuta a migliorare e aiuta i futuri ospiti a scegliere.\n\nBasta un minuto — tocca una stella qui sotto per iniziare.",
    },
    pt: {
      subject: "Como foi a sua estadia em {hotel_name}?",
      subject2: "Um minuto para avaliar a sua estadia, {guest_first_name}?",
      subject3: "Última oportunidade para avaliar a sua estadia em {hotel_name}",
      heading: "Como foi a sua estadia, {guest_first_name}?",
      intro:
        "Obrigado por ficar em {hotel_name}. Gostávamos de saber como correu — a sua opinião ajuda-nos a melhorar e ajuda futuros hóspedes a escolher.\n\nDemora apenas um minuto — toque numa estrela abaixo para começar.",
    },
    nl: {
      subject: "Hoe was je verblijf bij {hotel_name}?",
      subject2: "Een minuutje om uw verblijf te beoordelen, {guest_first_name}?",
      subject3: "Laatste kans om uw verblijf bij {hotel_name} te beoordelen",
      heading: "Hoe was je verblijf, {guest_first_name}?",
      intro:
        "Bedankt voor je verblijf bij {hotel_name}. We horen graag hoe het was — jouw feedback helpt ons verbeteren en helpt toekomstige gasten kiezen.\n\nHet duurt maar een minuut — tik hieronder op een ster om te beginnen.",
    },
    el: {
      subject: "Πώς ήταν η διαμονή σας στο {hotel_name};",
      subject2: "Ένα λεπτό για να βαθμολογήσετε τη διαμονή σας, {guest_first_name};",
      subject3: "Τελευταία ευκαιρία να αξιολογήσετε τη διαμονή σας στο {hotel_name}",
      heading: "Πώς ήταν η διαμονή σας, {guest_first_name};",
      intro:
        "Ευχαριστούμε που μείνατε στο {hotel_name}. Θα θέλαμε πολύ να μάθουμε πώς ήταν — τα σχόλιά σας μας βοηθούν να βελτιωνόμαστε και βοηθούν τους επόμενους επισκέπτες να επιλέξουν.\n\nΧρειάζεται μόνο ένα λεπτό — πατήστε ένα αστέρι παρακάτω για να ξεκινήσετε.",
    },
    th: {
      subject: "การเข้าพักที่ {hotel_name} เป็นอย่างไรบ้าง",
      subject2: "ขอเวลาสักครู่เพื่อให้คะแนนการเข้าพักของคุณไหม {guest_first_name}",
      subject3: "โอกาสสุดท้ายในการรีวิวการเข้าพักของคุณที่ {hotel_name}",
      heading: "การเข้าพักเป็นอย่างไรบ้าง คุณ{guest_first_name}",
      intro:
        "ขอบคุณที่เข้าพักที่ {hotel_name} เราอยากทราบว่าเป็นอย่างไรบ้าง — ความคิดเห็นของคุณช่วยให้เราพัฒนาและช่วยให้ผู้เข้าพักในอนาคตตัดสินใจได้\n\nใช้เวลาเพียงนาทีเดียว — แตะดาวด้านล่างเพื่อเริ่ม",
    },
    tr: {
      subject: "{hotel_name} konaklamanız nasıldı?",
      subject2: "Konaklamanızı puanlamak için bir dakikanız var mı {guest_first_name}?",
      subject3: "{hotel_name} konaklamanızı değerlendirmek için son şans",
      heading: "Konaklamanız nasıldı, {guest_first_name}?",
      intro:
        "{hotel_name} tesisinde konakladığınız için teşekkürler. Nasıl geçtiğini duymayı çok isteriz — geri bildiriminiz hem gelişmemize hem de gelecekteki misafirlerin seçim yapmasına yardımcı olur.\n\nYalnızca bir dakika sürer — başlamak için aşağıdaki yıldızlardan birine dokunun.",
    },
  },
};

/** Built-in email defaults for a language (English fields fill any gaps). */
export function emailDefaults(id: string, lang: string): Record<string, string> {
  const def = emailDef(id);
  const en: Record<string, string> = {};
  if (def) for (const f of def.fields) en[f.key] = f.default;
  if (lang === DEFAULT_LANG) return en;
  return { ...en, ...(EMAIL_TRANSLATIONS[id]?.[lang] ?? {}) };
}

/** Merge stored overrides over an email template's language-aware defaults. */
export function withEmailDefaults(
  id: string,
  overrides: Record<string, string | undefined> = {},
  lang: string = DEFAULT_LANG,
): Record<string, string> {
  const defaults = emailDefaults(id, lang);
  const out: Record<string, string> = {};
  for (const key of Object.keys(defaults)) out[key] = overrides[key]?.trim() || defaults[key];
  return out;
}
