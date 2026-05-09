// Vornamen → Geschlecht-Lookup + Heuristik.
// Manuell gesetzt via /setgender überschreibt jede Auto-Detection.
// Fallback ist 'd' (divers/neutral) — dann wird die neutrale Form verwendet.

const FEMALE = new Set([
    'anna','maria','sophie','sophia','emma','lena','lisa','hannah','hanna','mia',
    'julia','sarah','sara','laura','nina','lara','lea','leah','mila','emilia',
    'marie','lina','klara','clara','amelie','lilly','lilli','charlotte','antonia','isabella',
    'luisa','louisa','ella','marlene','greta','frieda','pauline','theresa','therese','karoline',
    'alina','helena','luise','lotta','stella','johanna','karla','carla','romy','ronja',
    'liv','magdalena','annika','nele','mara','mathilda','jana','tina','petra','sabine',
    'christine','christina','stefanie','stephanie','sandra','andrea','manuela','susanne','karin','karen',
    'birgit','beate','renate','ursula','ute','heike','elke','monika','brigitte','ingrid',
    'helga','erika','gisela','helene','hildegard','edith','gertrud','margarete','margret','ruth',
    'eva','anke','ines','gabriele','bettina','birte','beatrix','doris','diana','dagmar',
    'gudrun','heidi','ilse','inge','irene','luzia','lucia','marlies','marina','marion',
    'martina','melanie','michaela','nicole','nora','patricia','peggy','regina','rita','rosa',
    'rosemarie','sabrina','selina','silvia','simone','sonja','tanja','ulrike','uta','vanessa',
    'verena','veronika','waltraud','yvonne','zoe','katja','katharina','kathrin','tabea','franziska',
    'fanny','janine','jasmin','jessica','jenny','jennifer','steffi','melissa','vivien','viviane',
    'mira','mona','janna','marlena','rebecca','rebekka','annabelle','annabella','victoria','vicky',
    'fiona','sina','svenja','britta','kerstin','kirsten','christel','elisabeth','marianne','rosalie'
]);

const MALE = new Set([
    'tim','tom','max','maximilian','lukas','luca','leon','felix','paul','jonas',
    'niklas','nils','linus','finn','levi','elias','noah','ben','bennet','henri',
    'henry','theo','jakob','jacob','julian','david','daniel','simon','marc','mark',
    'andreas','christian','stefan','stephan','michael','thomas','peter','klaus','hans','hannes',
    'heinz','helmut','werner','wolfgang','walter','manfred','martin','matthias','markus','dieter',
    'detlef','juergen','jürgen','karl','kurt','norbert','reinhard','rolf','rainer','volker',
    'frank','fred','friedrich','fritz','erich','eberhard','guenter','günter','günther','gerd',
    'gerhard','hermann','herbert','holger','horst','achim','alexander','christoph','florian','fabian',
    'tobias','sven','thorsten','torsten','sebastian','robert','ralf','roman','rudolf','rüdiger',
    'sascha','joachim','jens','johann','johannes','karsten','kai','lars','marcel','mario',
    'marvin','mathias','matti','mehmet','moritz','olaf','oliver','oskar','otto','patrick',
    'philipp','philip','phillip','rene','renee','steffen','steven','timo','toni','vincent',
    'yannick','anton','arne','arnold','axel','bernd','bernhard','bjoern','björn','christof',
    'claus','dennis','dirk','dominik','egon','emil','enrico','ernst','franz','gunther',
    'günter','hartmut','holger','jan','joerg','jörg','jonathan','juergen','justin','kevin',
    'konstantin','leander','lennart','marius','milan','nick','nico','nicolas','pascal','rico',
    'rico','samuel','silas','tobi','udo','uwe','viktor','vladimir','wilhelm','willi'
]);

function normalizeFirstName(s) {
    if (!s) return '';
    return String(s).toLowerCase().trim()
        .replace(/[^a-zäöüßéèêàâ\s\-]/g, '')
        .split(/[\s\-]/)[0] || '';
}

function detectGender(firstName) {
    const n = normalizeFirstName(firstName);
    if (!n || n.length < 2) return null;
    if (FEMALE.has(n)) return 'w';
    if (MALE.has(n)) return 'm';
    // Heuristik für nicht-gelistete Namen.
    // -a / -ia / -ina / -ine / -elle / -ette / -etta deutet stark auf weiblich.
    if (/(a|ia|ina|ine|elle|ette|etta|elia|ella)$/.test(n) && n.length >= 4) return 'w';
    // -er / -mann / -us deutet auf männlich (Marker, Lehmann, Markus).
    if (/(mann|us)$/.test(n) && n.length >= 4) return 'm';
    return null;
}

// genderize(user, mForm, wForm, neutralForm)
// user kann uid (string) oder ein User-Objekt sein.
// Bevorzugt u.gender wenn manuell gesetzt, sonst Auto-Detect aus name/spitzname.
function genderize(user, mForm, wForm, neutralForm = null) {
    const u = (typeof user === 'object' && user) ? user : null;
    const explicit = u?.gender;
    if (explicit === 'm') return mForm;
    if (explicit === 'w') return wForm;
    if (explicit === 'd') return neutralForm ?? mForm;
    // Auto-detect
    const detected = u ? detectGender(u.spitzname || u.name || u.first_name || '') : null;
    if (detected === 'w') return wForm;
    if (detected === 'm') return mForm;
    return neutralForm ?? mForm;
}

export { detectGender, genderize, normalizeFirstName, FEMALE, MALE };
