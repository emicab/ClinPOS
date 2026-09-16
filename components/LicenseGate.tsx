"use client";

import React, { useState, useEffect } from 'react';
import ActivationScreen from './ActivationScreen';

interface LicenseGateProps {
  children: React.ReactNode;
}

const LicenseGate: React.FC<LicenseGateProps> = ({ children }) => {
    const [isLicensed, setIsLicensed] = useState<boolean>(false);
    const [isFree, setIsFree] = useState<boolean>(false);
    const [isLoading, setIsLoading] = useState<boolean>(true);

    const checkLicense = async () => {
        setIsLoading(true);
        try {
            const res = await fetch('/api/config');
            if (res.ok) {
                const config = await res.json();
                const hasLicense = !!config.license_key && config.license_key.trim() !== '';
                const isFreeMode = localStorage.getItem('free_mode_active') === 'true';

                // Revalidar el plan online contra la nube (detecta bajas mensuales).
                // Solo la Casa Central tiene license_key; en sucursales no cambia nada.
                if (hasLicense) {
                    try {
                        await fetch('/api/license/check', { method: 'POST' });
                    } catch (e) {
                        console.warn('No se pudo revalidar la licencia al iniciar:', e);
                    }
                }

                setIsLicensed(hasLicense);
                setIsFree(!hasLicense && isFreeMode);
            } else {
                // Un 403 es un problema de autenticación del servidor local,
                // no una condición para reintentar indefinidamente.
                if (res.status === 403) {
                    console.warn('Servidor local no autenticado. Se detiene el reintento automático.');
                    setIsLoading(false);
                    return;
                }
                console.warn('API returned non-OK status');
                setTimeout(checkLicense, 2000);
                return;
            }
        } catch (e) {
            console.warn('API no está lista, reintentando en 500ms...', e);
            setTimeout(checkLicense, 500);
            return;
        }
        setIsLoading(false);
    };

    useEffect(() => {
        checkLicense();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleContinueFree = async () => {
        localStorage.setItem('free_mode_active', 'true');
        checkLicense();
    };

    if (isLoading) {
        return (
            <div className="flex min-h-screen w-full items-center justify-center bg-gray-100 dark:bg-gray-950">
                <div className="text-center">
                    <p className="text-lg text-gray-600 dark:text-gray-300">Verificando licencia...</p>
                </div>
            </div>
        );
    }

    if (isLicensed || isFree) {
        return <>{children}</>;
    }

    return <ActivationScreen onActivationSuccess={checkLicense} onContinueFree={handleContinueFree} />;
};

export default LicenseGate;
