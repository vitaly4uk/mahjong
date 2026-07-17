from whitenoise.storage import CompressedManifestStaticFilesStorage


class GameStaticFilesStorage(CompressedManifestStaticFilesStorage):
    """collectstatic переписує не лише url()/@import у CSS, а й самі ES-module
    import/export у static/game/*.js на хешовані імена (офіційна, але вимкнена
    за замовчуванням фіча Django — HashedFilesMixin.support_js_module_import_
    aggregation). Без цього лише вхідний main.js отримує новий хеш при кожному
    деплої (він підключений через {% static %}), а його внутрішні
    `import ... from './render-constants.js'` лишаються під тим самим
    незмінним URL — застарілий кешований клієнт (напр. вже встановлений
    standalone-застосунок на macOS) може отримати нову версію main.js разом
    зі старою version render-constants.js і впасти з SyntaxError на
    неузгодженому імпорті. З хешованими іменами зміна вмісту будь-якого
    залежного файлу автоматично міняє URL усіх, хто його імпортує."""

    support_js_module_import_aggregation = True
