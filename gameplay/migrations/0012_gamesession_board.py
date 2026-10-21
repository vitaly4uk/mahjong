from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ('gameplay', '0011_backfill_daily_scores'),
    ]

    operations = [
        migrations.AddField(
            model_name='gamesession',
            name='board',
            field=models.CharField(blank=True, default='', max_length=32),
        ),
    ]
